// Unit tests — scan-location capture (Task #45, PO decision obs #733).
//
// Contract under test (logScanAction → logScan use-case):
//   (a) Every scanner-role scan records `scan_ip_area` (coarse, city precision)
//       with recordedByUserId = NULL — even for authenticated non-owner viewers.
//   (b) Precise GPS (`scan_coords` + `scan_accuracy_m`) is stored ONLY when the
//       pet is lost AND coords were passed (explicit browser grant). The lost
//       check is server-side: coords on a non-lost pet are dropped. Invalid
//       coords are dropped. Self-scans never carry any location field.
//   (c) No read path exposes scanner identity: the owner-timeline detail
//       renderer emits zero rows for credential_scanned payloads, and the
//       written event carries no identity-linking field.
//
// The db / auth / headers surfaces are mocked following the pattern of
// finder-in-possession-action.test.ts. validateEventPayload is NOT mocked —
// the real Zod schema validates every payload these tests produce.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PUBLIC_TOKEN = "DIM-SCAN-LOC-001";
const PET_ID = "pet-scan-0000-0000-000000000001";
const OWNER_USER_ID = "user-scan-0000-0000-000000000001";
const VISITOR_USER_ID = "user-scan-0000-0000-000000000002";

// ---------------------------------------------------------------------------
// Mock: next/headers — Vercel geo headers (URI-encoded city, like production).
// Mutable so individual tests can blank them out.
// ---------------------------------------------------------------------------

let mockGeoHeaders: Record<string, string> = {};

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (key: string) => mockGeoHeaders[key] ?? null,
  })),
}));

function setVercelGeoHeaders() {
  mockGeoHeaders = {
    "x-vercel-ip-city": "La%20Plata",
    "x-vercel-ip-country-region": "B",
    "x-vercel-ip-country": "AR",
    // The raw-IP headers exist on every request — the helper must never read them.
    "x-real-ip": "203.0.113.9",
    "x-forwarded-for": "203.0.113.9",
  };
}

// ---------------------------------------------------------------------------
// Mock: @/lib/supabase/server — anonymous by default.
// ---------------------------------------------------------------------------

const mockGetUser = vi.fn(async () => ({
  data: { user: null as { id: string } | null },
  error: null,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: () => mockGetUser() } })),
}));

// ---------------------------------------------------------------------------
// Mock: @/lib/infra/rate-limit — these tests assert payload shape, not rate
// limiting. enforceRateLimit is a no-op so every scan reaches the insert (the
// real limiter is covered by scan-log-rate-limit.test.ts). callerIp reads the
// trusted x-real-ip header, matching production.
// ---------------------------------------------------------------------------

vi.mock("@/lib/infra/rate-limit", () => ({
  enforceRateLimit: vi.fn(async () => {}),
  callerIp: (h: { get(k: string): string | null }) => h.get("x-real-ip") ?? "unknown",
  RateLimitError: class RateLimitError extends Error {},
}));

// ---------------------------------------------------------------------------
// Mock: @/lib/infra/notify-owner-of-first-stranger-scan — asserted directly
// below (owner-onboarding train), decoupled from the @/db mock's shape.
// ---------------------------------------------------------------------------

const mockNotifyFirstStrangerScan = vi.fn(async (..._args: unknown[]) => ({ delivered: 0 }));
vi.mock("@/lib/infra/notify-owner-of-first-stranger-scan", () => ({
  notifyOwnerOfFirstStrangerScan: (...args: unknown[]) => mockNotifyFirstStrangerScan(...args),
}));

// ---------------------------------------------------------------------------
// Mock: @/db — select chain routes pet + ownership queries; insert is captured.
// ---------------------------------------------------------------------------

let petRow: { id: string; status: string } | null = null;
let viewerIsOwner = false;
let capturedInsert: Record<string, unknown> | null = null;

const mockDb: { select: ReturnType<typeof vi.fn>; insert: ReturnType<typeof vi.fn> } = {
  select: vi.fn(),
  insert: vi.fn(),
};

function buildMockDb() {
  let selectCallCount = 0;
  const selectChain = {
    from: vi.fn(() => selectChain),
    where: vi.fn(() => selectChain),
    limit: vi.fn(async () => {
      selectCallCount++;
      if (selectCallCount === 1) {
        // pet lookup by public token
        return petRow ? [petRow] : [];
      }
      // ownership lookup (only reached when a user is authenticated)
      return viewerIsOwner ? [{ id: "ownership-1" }] : [];
    }),
  };
  const insertChain = {
    values: vi.fn(async (data: Record<string, unknown>) => {
      capturedInsert = data;
    }),
  };
  mockDb.select = vi.fn(() => selectChain);
  mockDb.insert = vi.fn(() => insertChain);
}

vi.mock("@/db", () => ({
  db: mockDb,
  pets: {},
  ownerships: {},
  petEvents: {},
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runScan(coords?: { lat: number; lng: number; accuracyM?: number }) {
  const { logScanAction } = await import("@/app/actions/scans");
  await logScanAction(PUBLIC_TOKEN, coords);
}

function payloadOf(insert: Record<string, unknown> | null): Record<string, unknown> {
  expect(insert).not.toBeNull();
  return (insert?.payload ?? {}) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("logScanAction — scan-location capture (Task #45)", () => {
  beforeEach(() => {
    capturedInsert = null;
    petRow = { id: PET_ID, status: "active" };
    viewerIsOwner = false;
    setVercelGeoHeaders();
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    buildMockDb();
    mockNotifyFirstStrangerScan.mockClear();
  });

  // --- (d) first-stranger-scan notification guard (owner-onboarding train) ---

  it("calls the first-stranger-scan notifier on an anonymous (non-self) scan", async () => {
    await runScan();

    expect(mockNotifyFirstStrangerScan).toHaveBeenCalledTimes(1);
    expect(mockNotifyFirstStrangerScan.mock.calls[0][0]).toMatchObject({
      petId: PET_ID,
      petPublicToken: PUBLIC_TOKEN,
    });
  });

  it("calls the notifier on an authenticated NON-owner scan too", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: VISITOR_USER_ID } }, error: null });

    await runScan();

    expect(mockNotifyFirstStrangerScan).toHaveBeenCalledTimes(1);
  });

  it("does NOT call the notifier on a self-scan", async () => {
    viewerIsOwner = true;
    mockGetUser.mockResolvedValue({ data: { user: { id: OWNER_USER_ID } }, error: null });

    await runScan();

    expect(mockNotifyFirstStrangerScan).not.toHaveBeenCalled();
  });

  // --- (a) coarse IP-area floor, hard-anonymized ---

  it("anonymous scan records scan_ip_area (decoded, city precision) with NO user id", async () => {
    await runScan();

    const payload = payloadOf(capturedInsert);
    expect(payload.scan_ip_area).toEqual({ city: "La Plata", region: "B", country: "AR" });
    expect(capturedInsert?.recordedByUserId).toBeNull();
    expect(capturedInsert?.authorRole).toBe("scanner");
    expect(payload.is_self_scan).toBe(false);
    expect(payload.viewer_authenticated).toBe(false);
    // No GPS without lost + grant.
    expect(payload).not.toHaveProperty("scan_coords");
    expect(payload).not.toHaveProperty("scan_accuracy_m");
  });

  it("authenticated NON-owner scan is hard-anonymized: recordedByUserId stays NULL", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: VISITOR_USER_ID } }, error: null });

    await runScan();

    const payload = payloadOf(capturedInsert);
    expect(capturedInsert?.recordedByUserId).toBeNull();
    expect(capturedInsert?.authorRole).toBe("scanner");
    expect(payload.viewer_authenticated).toBe(true);
    expect(payload.scan_ip_area).toEqual({ city: "La Plata", region: "B", country: "AR" });
    // The visitor's id must not appear anywhere in the row.
    expect(JSON.stringify(capturedInsert)).not.toContain(VISITOR_USER_ID);
  });

  it("records scan_ip_area: null when the platform geo headers are absent (local dev)", async () => {
    mockGeoHeaders = { "x-real-ip": "203.0.113.9" }; // raw IP present, geo absent

    await runScan();

    const payload = payloadOf(capturedInsert);
    expect(payload.scan_ip_area).toBeNull();
    // The raw IP never leaks into the event row.
    expect(JSON.stringify(capturedInsert)).not.toContain("203.0.113.9");
  });

  // --- (b) precise GPS only when lost + granted ---

  it("stores scan_coords + scan_accuracy_m when the pet is lost and coords were granted", async () => {
    petRow = { id: PET_ID, status: "lost" };

    await runScan({ lat: -34.9205, lng: -57.9536, accuracyM: 24.6 });

    const payload = payloadOf(capturedInsert);
    expect(payload.scan_coords).toEqual({ lat: -34.9205, lng: -57.9536 });
    expect(payload.scan_accuracy_m).toBe(25); // rounded server-side
    expect(payload.scan_ip_area).toEqual({ city: "La Plata", region: "B", country: "AR" });
    expect(capturedInsert?.recordedByUserId).toBeNull();
  });

  it("DROPS coords when the pet is NOT lost (server-side enforcement)", async () => {
    petRow = { id: PET_ID, status: "active" };

    await runScan({ lat: -34.9205, lng: -57.9536, accuracyM: 10 });

    const payload = payloadOf(capturedInsert);
    expect(payload).not.toHaveProperty("scan_coords");
    expect(payload).not.toHaveProperty("scan_accuracy_m");
    // The scan itself is still recorded (coarse floor).
    expect(payload.scan_ip_area).toEqual({ city: "La Plata", region: "B", country: "AR" });
  });

  it("DROPS out-of-range coords but still records the scan", async () => {
    petRow = { id: PET_ID, status: "lost" };

    await runScan({ lat: 999, lng: -57.9536 });

    const payload = payloadOf(capturedInsert);
    expect(payload).not.toHaveProperty("scan_coords");
    expect(capturedInsert?.eventType).toBe("credential_scanned");
  });

  // --- self-scans: identity-linked rows never carry location ---

  it("self-scan keeps the owner id but carries NO location fields, even on a lost pet", async () => {
    petRow = { id: PET_ID, status: "lost" };
    viewerIsOwner = true;
    mockGetUser.mockResolvedValue({ data: { user: { id: OWNER_USER_ID } }, error: null });

    await runScan({ lat: -34.9205, lng: -57.9536, accuracyM: 10 });

    const payload = payloadOf(capturedInsert);
    expect(payload.is_self_scan).toBe(true);
    expect(capturedInsert?.authorRole).toBe("owner");
    expect(capturedInsert?.recordedByUserId).toBe(OWNER_USER_ID);
    // Owner-role rows are exempt from the 90d purge → they must never
    // accumulate location data.
    expect(payload).not.toHaveProperty("scan_ip_area");
    expect(payload).not.toHaveProperty("scan_coords");
    expect(payload).not.toHaveProperty("scan_accuracy_m");
  });

  // --- (c) read path: owner-timeline detail renderer leaks nothing ---

  it("eventPayloadDetails renders ZERO rows for a fully-loaded scan payload", async () => {
    const { eventPayloadDetails } = await import("@/lib/events/events");
    const rows = eventPayloadDetails("credential_scanned", {
      payload_version: 1,
      is_self_scan: false,
      viewer_authenticated: true,
      scan_ip_area: { city: "La Plata", region: "B", country: "AR" },
      scan_coords: { lat: -34.9205, lng: -57.9536 },
      scan_accuracy_m: 25,
    });
    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ipAreaFromHeaders — pure helper
// ---------------------------------------------------------------------------

describe("ipAreaFromHeaders", () => {
  it("decodes URI-encoded Vercel header values", async () => {
    const { ipAreaFromHeaders } = await import("@/lib/infra/scan-geo");
    const area = ipAreaFromHeaders({
      get: (k: string) =>
        (
          ({
            "x-vercel-ip-city": "Mar%20del%20Plata",
            "x-vercel-ip-country-region": "B",
            "x-vercel-ip-country": "AR",
          }) as Record<string, string>
        )[k] ?? null,
    });
    expect(area).toEqual({ city: "Mar del Plata", region: "B", country: "AR" });
  });

  it("returns null when no geo header is present", async () => {
    const { ipAreaFromHeaders } = await import("@/lib/infra/scan-geo");
    expect(ipAreaFromHeaders({ get: () => null })).toBeNull();
  });

  it("truncates oversized header values (spoofing guard)", async () => {
    const { ipAreaFromHeaders } = await import("@/lib/infra/scan-geo");
    const area = ipAreaFromHeaders({
      get: (k: string) => (k === "x-vercel-ip-city" ? "x".repeat(500) : null),
    });
    expect(area?.city).toHaveLength(120);
  });
});
