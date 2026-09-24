// Unit test for the Panorama KPI short-TTL server cache.
//
// The SECURITY-CRITICAL property under test: the cache key IS the isolation
// boundary. Two operators with different authorization scopes must map to
// different keys (no cross-jurisdiction leakage), while the SAME scope must hit
// the cache. Degraded results must never be cached. All deterministic — an
// injected clock, no DB, no timers.

import { beforeEach, describe, expect, it } from "vitest";

import type { DashboardJurisdiction } from "@/lib/metrics";

import type { PanoramaKpis } from "../get-panorama-kpis";
import {
  KPIS_CACHE_TTL_MS,
  __resetKpisCache,
  getCachedPanoramaKpis,
  kpiCacheKey,
} from "../kpis-cache";

const AT = new Date("2026-07-04T12:00:00.000Z").getTime();

/** A successful (non-degraded) strip carrying one placeholder tile. */
function okKpis(marker: string): PanoramaKpis {
  return {
    kpis: [{ id: "cobertura", value: marker } as PanoramaKpis["kpis"][number]],
    recalculatedFor: marker,
    dataAsOf: null,
  };
}

/** A degraded strip — no tiles (what withDbBudget's fallback returns). */
function degraded(): PanoramaKpis {
  return { kpis: [], recalculatedFor: "No pudimos cargar los indicadores.", dataAsOf: null };
}

const since = new Date("2023-07-04T12:00:00.000Z");
const until = new Date("2026-07-04T12:00:00.000Z");

beforeEach(() => {
  __resetKpisCache();
});

describe("kpiCacheKey — scope isolation", () => {
  const baBaires: DashboardJurisdiction = { province: "Buenos Aires", locality: "La Plata" };
  const sfRosario: DashboardJurisdiction = { province: "Santa Fe", locality: "Rosario" };

  it("different jurisdiction sets → different keys (no cross-jurisdiction leakage)", () => {
    const a = kpiCacheKey({ role: "govt", jurisdictions: [baBaires], since, until });
    const b = kpiCacheKey({ role: "govt", jurisdictions: [sfRosario], since, until });
    expect(a).not.toBe(b);
  });

  it("same jurisdiction set → same key regardless of ORDER (order-independent)", () => {
    const a = kpiCacheKey({ role: "govt", jurisdictions: [baBaires, sfRosario], since, until });
    const b = kpiCacheKey({ role: "govt", jurisdictions: [sfRosario, baBaires], since, until });
    expect(a).toBe(b);
  });

  it("role is part of the key (admin national ≠ govt with no jurisdictions)", () => {
    const admin = kpiCacheKey({ role: "admin", jurisdictions: [], since, until });
    const govt = kpiCacheKey({ role: "govt", jurisdictions: [], since, until });
    expect(admin).not.toBe(govt);
  });

  it("admin drill-down province/locality change the key", () => {
    const national = kpiCacheKey({ role: "admin", jurisdictions: [], since, until });
    const province = kpiCacheKey({
      role: "admin",
      jurisdictions: [],
      since,
      until,
      adminProvince: "Buenos Aires",
    });
    const locality = kpiCacheKey({
      role: "admin",
      jurisdictions: [],
      since,
      until,
      adminProvince: "Buenos Aires",
      adminLocality: "La Plata",
    });
    expect(new Set([national, province, locality]).size).toBe(3);
  });

  it("period window is part of the key", () => {
    const a = kpiCacheKey({ role: "admin", jurisdictions: [], since, until });
    const b = kpiCacheKey({
      role: "admin",
      jurisdictions: [],
      since: new Date("2025-07-04T12:00:00.000Z"),
      until,
    });
    expect(a).not.toBe(b);
  });

  it("the temporal-scrub cutoff (asOf) is part of the key — a scrubbed frame never aliases live", () => {
    const live = kpiCacheKey({ role: "admin", jurisdictions: [], since, until });
    const scrubbed = kpiCacheKey({
      role: "admin",
      jurisdictions: [],
      since,
      until,
      asOf: new Date("2026-05-01T00:00:00.000Z"),
    });
    const scrubbedElsewhere = kpiCacheKey({
      role: "admin",
      jurisdictions: [],
      since,
      until,
      asOf: new Date("2026-04-01T00:00:00.000Z"),
    });
    expect(scrubbed).not.toBe(live);
    expect(scrubbed).not.toBe(scrubbedElsewhere);
    // A null asOf is the live default — identical to omitting it.
    expect(kpiCacheKey({ role: "admin", jurisdictions: [], since, until, asOf: null })).toBe(live);
  });

  it("a moving preset `until` within the same TTL bucket keeps the key stable", () => {
    const t = AT;
    const a = kpiCacheKey({
      role: "admin",
      jurisdictions: [],
      since,
      until: new Date(t),
    });
    // 5s later — still inside the same 60s bucket → identical key.
    const b = kpiCacheKey({
      role: "admin",
      jurisdictions: [],
      since,
      until: new Date(t + 5_000),
    });
    expect(a).toBe(b);
  });
});

describe("getCachedPanoramaKpis — hit/miss + degraded handling", () => {
  const key = kpiCacheKey({
    role: "govt",
    jurisdictions: [{ province: "BA", locality: "LP" }],
    since,
    until,
  });

  it("first call misses and computes; second call with the same key hits", async () => {
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return okKpis(`run-${calls}`);
    };

    const first = await getCachedPanoramaKpis(key, compute, {
      shouldCache: (v) => v.kpis.length > 0,
      now: () => AT,
    });
    expect(first.cacheHit).toBe(false);
    expect(first.value.recalculatedFor).toBe("run-1");

    const second = await getCachedPanoramaKpis(key, compute, {
      shouldCache: (v) => v.kpis.length > 0,
      now: () => AT + 1_000,
    });
    expect(second.cacheHit).toBe(true);
    expect(second.value.recalculatedFor).toBe("run-1"); // served from cache, NOT recomputed
    expect(calls).toBe(1);
  });

  it("different scopes never share an entry (isolation through the full get flow)", async () => {
    const keyA = kpiCacheKey({
      role: "govt",
      jurisdictions: [{ province: "BA", locality: "LP" }],
      since,
      until,
    });
    const keyB = kpiCacheKey({
      role: "govt",
      jurisdictions: [{ province: "SF", locality: "Rosario" }],
      since,
      until,
    });

    await getCachedPanoramaKpis(keyA, async () => okKpis("scope-A"), {
      shouldCache: (v) => v.kpis.length > 0,
      now: () => AT,
    });
    const b = await getCachedPanoramaKpis(keyB, async () => okKpis("scope-B"), {
      shouldCache: (v) => v.kpis.length > 0,
      now: () => AT,
    });
    // B computed its own value — it did NOT read A's cached entry.
    expect(b.cacheHit).toBe(false);
    expect(b.value.recalculatedFor).toBe("scope-B");

    // A is still its own value (unpolluted by B).
    const a = await getCachedPanoramaKpis(keyA, async () => okKpis("scope-A-again"), {
      shouldCache: (v) => v.kpis.length > 0,
      now: () => AT,
    });
    expect(a.cacheHit).toBe(true);
    expect(a.value.recalculatedFor).toBe("scope-A");
  });

  it("degraded results are NOT cached — the next call recomputes", async () => {
    const firstDegraded = await getCachedPanoramaKpis(key, async () => degraded(), {
      shouldCache: (v) => v.kpis.length > 0,
      now: () => AT,
    });
    expect(firstDegraded.cacheHit).toBe(false);

    // A subsequent success must NOT hit the (uncached) degraded entry.
    const recovered = await getCachedPanoramaKpis(key, async () => okKpis("recovered"), {
      shouldCache: (v) => v.kpis.length > 0,
      now: () => AT + 1_000,
    });
    expect(recovered.cacheHit).toBe(false);
    expect(recovered.value.recalculatedFor).toBe("recovered");
  });

  it("entries expire after the TTL", async () => {
    await getCachedPanoramaKpis(key, async () => okKpis("v1"), {
      shouldCache: (v) => v.kpis.length > 0,
      now: () => AT,
    });
    // Past the TTL → miss + recompute.
    const afterTtl = await getCachedPanoramaKpis(key, async () => okKpis("v2"), {
      shouldCache: (v) => v.kpis.length > 0,
      now: () => AT + KPIS_CACHE_TTL_MS + 1,
    });
    expect(afterTtl.cacheHit).toBe(false);
    expect(afterTtl.value.recalculatedFor).toBe("v2");
  });
});
