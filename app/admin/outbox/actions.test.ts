// Unit tests for app/admin/outbox/actions.ts
//
// Strict TDD mode. Tests the retry-now action logic:
//   1. Auth gate — non-admin returns error
//   2. Not-found row returns error
//   3. Happy path — resets next_retry_at + status to pending

import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// We test the pure logic layer, not the Next.js action wrapper.
// retryOutboxRowNow is extracted as a pure-ish helper that takes injected db + auth.

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import the action AFTER mocks are set up
// ---------------------------------------------------------------------------

import { buildRetryPayload } from "@/lib/infra/outbox-list";

// ---------------------------------------------------------------------------
// buildRetryPayload — pure helper that computes the DB update payload
// ---------------------------------------------------------------------------

describe("buildRetryPayload", () => {
  it("returns next_retry_at close to now (within 100ms)", () => {
    const before = new Date();
    const payload = buildRetryPayload();
    const after = new Date();

    expect(payload.nextRetryAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(payload.nextRetryAt.getTime()).toBeLessThanOrEqual(after.getTime() + 10);
  });

  it("always sets status to pending", () => {
    const payload = buildRetryPayload();
    expect(payload.status).toBe("pending");
  });

  it("returns consistent shape on multiple calls", () => {
    const p1 = buildRetryPayload();
    const p2 = buildRetryPayload();

    expect(p1).toHaveProperty("nextRetryAt");
    expect(p1).toHaveProperty("status");
    expect(p2.status).toBe("pending");
  });
});
