// WAVE D4 — abuse controls on the anonymous credential_scanned write.
//
// The public scan-logging path (logScanAction → logScan use-case) had NO rate
// limit and NO dedupe: any client could call the server action in a loop and
// forge an unbounded number of scans, inflating a pet's public scan count.
//
// These tests exercise the REAL enforceRateLimit + dedupe wiring against an
// in-memory rate_limit_buckets store (a faithful stand-in for the DB-backed
// atomic UPSERT). Contract:
//   - A burst of base scans from one (token, IP) records only ONE scan
//     (per-minute dedupe collapses the same person's re-renders).
//   - A single legitimate scan still records.
//   - A lost-pet GPS follow-up is EXEMPT from dedupe, so the base scan + the
//     just-granted fix both record.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Shared, hoisted state — an in-memory bucket store + captured petEvents inserts.
// enforceRateLimit (the REAL implementation) drives the bucket store through the
// db.insert(rateLimitBuckets)…onConflictDoUpdate…returning chain we emulate here.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => {
  const rateLimitBucketsRef = { __table: "rate_limit_buckets" };
  const petEventsRef = { __table: "pet_events" };
  return {
    rateLimitBucketsRef,
    petEventsRef,
    bucketCounts: new Map<string, number>(),
    petEventInserts: [] as Record<string, unknown>[],
    state: { petStatus: "active" as string },
  };
});

// next/headers — trusted IP present, geo headers absent (local-dev shape).
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (k: string) => (k === "x-real-ip" ? "203.0.113.50" : null),
  })),
}));

// supabase — anonymous viewer.
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
  })),
}));

// @/db — pet lookup returns a single row; rateLimitBuckets insert drives the
// in-memory counter; petEvents insert is captured.
vi.mock("@/db", () => {
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: async () => [{ id: "pet-0000-0000-0000-000000000001", status: h.state.petStatus }],
  };
  function rlChain() {
    let key = "";
    const chain = {
      values: (v: { bucketKey: string }) => {
        key = v.bucketKey;
        return chain;
      },
      onConflictDoUpdate: () => chain,
      returning: async () => {
        const next = (h.bucketCounts.get(key) ?? 0) + 1;
        h.bucketCounts.set(key, next);
        return [{ count: next }];
      },
    };
    return chain;
  }
  return {
    db: {
      select: () => selectChain,
      insert: (table: unknown) =>
        table === h.rateLimitBucketsRef
          ? rlChain()
          : {
              values: async (data: Record<string, unknown>) => {
                h.petEventInserts.push(data);
              },
            },
    },
    pets: {},
    ownerships: {},
    petEvents: h.petEventsRef,
    rateLimitBuckets: h.rateLimitBucketsRef,
  };
});

const TOKEN = "DIM-SCAN-RL-0001";

async function scan(coords?: { lat: number; lng: number; accuracyM?: number }) {
  const { logScanAction } = await import("@/app/actions/scans");
  await logScanAction(TOKEN, coords);
}

describe("logScan — WAVE D4 rate limit + dedupe", () => {
  beforeEach(() => {
    h.bucketCounts.clear();
    h.petEventInserts.length = 0;
    h.state.petStatus = "active";
    // Freeze time so every scan in a test lands in the same clock-minute window
    // (the dedupe bucket is minute-aligned). Prevents a boundary-straddle flake.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T12:00:30.000Z"));
  });

  it("a burst of base scans from one IP records only ONE scan", async () => {
    for (let i = 0; i < 8; i++) await scan();
    expect(h.petEventInserts).toHaveLength(1);
  });

  it("a single legitimate scan still records", async () => {
    await scan();
    expect(h.petEventInserts).toHaveLength(1);
    expect(h.petEventInserts[0].eventType).toBe("credential_scanned");
  });

  it("a lost-pet GPS follow-up is exempt from dedupe: base + fix both record", async () => {
    h.state.petStatus = "lost";
    await scan(); // base scan (no coords)
    await scan({ lat: -34.9205, lng: -57.9536, accuracyM: 12 }); // granted GPS fix
    expect(h.petEventInserts).toHaveLength(2);
    const withCoords = h.petEventInserts.find(
      (r) => (r.payload as Record<string, unknown>).scan_coords,
    );
    expect(withCoords).toBeDefined();
  });
});
