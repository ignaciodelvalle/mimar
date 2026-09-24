// Unit test for the Panorama layer-features cache KEY builder.
//
// The SECURITY-CRITICAL property under test (mirrors kpis-cache): the cache key
// IS the isolation boundary. Two requests with different authorization scopes —
// role, jurisdiction set, admin drill-down, layer, level, window, basis, or the
// verified-only toggle — MUST map to different keys (no cross-scope leakage),
// while requests that differ only WITHIN a 300s window bucket must share a key
// (so a moving preset `until`/`asOf` still hits the cache). Pure — no DB, no
// timers, no Next runtime (only the key builder is exercised; the unstable_cache
// wrapper needs an incremental cache and is verified at runtime, not in a unit).

import { describe, expect, it } from "vitest";

import type { DashboardJurisdiction } from "@/lib/metrics";

import { LAYER_KEY_BUCKET_MS, layerCacheKey } from "../load-layer-features-cached";

const since = new Date("2023-07-04T12:00:00.000Z");
const asOf = new Date("2026-07-04T12:00:00.000Z");

const baLaPlata: DashboardJurisdiction = { province: "Buenos Aires", locality: "La Plata" };
const sfRosario: DashboardJurisdiction = { province: "Santa Fe", locality: "Rosario" };

describe("layerCacheKey — scope isolation", () => {
  it("different jurisdiction sets → different keys (no cross-jurisdiction leakage)", () => {
    const a = layerCacheKey({
      role: "govt",
      jurisdictions: [baLaPlata],
      layer: "perdidas",
      level: "locality",
      since,
      asOf,
    });
    const b = layerCacheKey({
      role: "govt",
      jurisdictions: [sfRosario],
      layer: "perdidas",
      level: "locality",
      since,
      asOf,
    });
    expect(a).not.toBe(b);
  });

  it("same jurisdiction set → same key regardless of ORDER (order-independent)", () => {
    const a = layerCacheKey({
      role: "govt",
      jurisdictions: [baLaPlata, sfRosario],
      layer: "perdidas",
      level: "locality",
      since,
      asOf,
    });
    const b = layerCacheKey({
      role: "govt",
      jurisdictions: [sfRosario, baLaPlata],
      layer: "perdidas",
      level: "locality",
      since,
      asOf,
    });
    expect(a).toBe(b);
  });

  it("role is part of the key (admin national ≠ govt with no jurisdictions)", () => {
    const admin = layerCacheKey({
      role: "admin",
      jurisdictions: [],
      layer: "perdidas",
      level: "province",
      since,
      asOf,
    });
    const govt = layerCacheKey({
      role: "govt",
      jurisdictions: [],
      layer: "perdidas",
      level: "province",
      since,
      asOf,
    });
    expect(admin).not.toBe(govt);
  });

  it("admin drill-down province/locality change the key", () => {
    const base = {
      role: "admin" as const,
      jurisdictions: [],
      layer: "perdidas" as const,
      level: "locality" as const,
      since,
      asOf,
    };
    const national = layerCacheKey(base);
    const province = layerCacheKey({ ...base, adminProvince: "Buenos Aires" });
    const locality = layerCacheKey({
      ...base,
      adminProvince: "Buenos Aires",
      adminLocality: "La Plata",
    });
    expect(new Set([national, province, locality]).size).toBe(3);
  });

  it("different layer → different keys", () => {
    const base = {
      role: "admin" as const,
      jurisdictions: [],
      level: "locality" as const,
      since,
      asOf,
    };
    const perdidas = layerCacheKey({ ...base, layer: "perdidas" });
    const mordeduras = layerCacheKey({ ...base, layer: "mordeduras" });
    const cobertura = layerCacheKey({ ...base, layer: "cobertura" });
    expect(new Set([perdidas, mordeduras, cobertura]).size).toBe(3);
  });

  it("different aggregation level → different keys", () => {
    const base = {
      role: "admin" as const,
      jurisdictions: [],
      layer: "cobertura" as const,
      since,
      asOf,
    };
    const locality = layerCacheKey({ ...base, level: "locality" });
    const province = layerCacheKey({ ...base, level: "province" });
    expect(locality).not.toBe(province);
  });

  it("different period window → different keys", () => {
    const base = {
      role: "admin" as const,
      jurisdictions: [],
      layer: "perdidas" as const,
      level: "locality" as const,
      asOf,
    };
    const a = layerCacheKey({ ...base, since });
    const b = layerCacheKey({ ...base, since: new Date("2025-07-04T12:00:00.000Z") });
    expect(a).not.toBe(b);
  });

  it("replay basis (valid vs transaction) is part of the key", () => {
    const base = {
      role: "admin" as const,
      jurisdictions: [],
      layer: "perdidas" as const,
      level: "locality" as const,
      since,
      asOf,
    };
    const valid = layerCacheKey({ ...base, basis: "valid" });
    const transaction = layerCacheKey({ ...base, basis: "transaction" });
    expect(valid).not.toBe(transaction);
    // Default basis matches an explicit "valid".
    expect(layerCacheKey(base)).toBe(valid);
  });

  it("verifiedOnly toggle is part of the key", () => {
    const base = {
      role: "admin" as const,
      jurisdictions: [],
      layer: "cobertura" as const,
      level: "province" as const,
      since,
      asOf,
    };
    const off = layerCacheKey({ ...base, verifiedOnly: false });
    const on = layerCacheKey({ ...base, verifiedOnly: true });
    expect(off).not.toBe(on);
    // Default (undefined) matches an explicit false.
    expect(layerCacheKey(base)).toBe(off);
  });
});

describe("layerCacheKey — window bucketing (moving-preset stability)", () => {
  const base = {
    role: "admin" as const,
    jurisdictions: [],
    layer: "perdidas" as const,
    level: "locality" as const,
  };
  const AT = new Date("2026-07-04T12:00:00.000Z").getTime();

  it("two `since` timestamps in the SAME 300s bucket → same key", () => {
    const a = layerCacheKey({ ...base, since: new Date(AT), asOf });
    // 5s later — still inside the same 300s bucket → identical key.
    const b = layerCacheKey({ ...base, since: new Date(AT + 5_000), asOf });
    expect(a).toBe(b);
  });

  it("two `asOf` timestamps in the SAME 300s bucket → same key", () => {
    const a = layerCacheKey({ ...base, since, asOf: new Date(AT) });
    const b = layerCacheKey({ ...base, since, asOf: new Date(AT + 5_000) });
    expect(a).toBe(b);
  });

  it("`since` timestamps in DIFFERENT buckets → different keys", () => {
    const a = layerCacheKey({ ...base, since: new Date(AT), asOf });
    const b = layerCacheKey({ ...base, since: new Date(AT + LAYER_KEY_BUCKET_MS), asOf });
    expect(a).not.toBe(b);
  });

  it("absent `asOf` (live edge) is a stable, distinct token from any bucketed asOf", () => {
    const live = layerCacheKey({ ...base, since });
    const bounded = layerCacheKey({ ...base, since, asOf });
    expect(live).not.toBe(bounded);
    // Two live-edge requests share a key (asOf token is the empty string).
    expect(layerCacheKey({ ...base, since })).toBe(live);
  });
});
