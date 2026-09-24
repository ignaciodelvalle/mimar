// Unit tests for domain/membership-state.ts — pure, no DB, no Next.js.
// Written FIRST (RED phase, task 1.5) before creating membership-state.ts.

import { describe, expect, it } from "vitest";

import {
  canDecide,
  inviteAcceptValidity,
  lastAdminBlocks,
} from "@/src/modules/organizations/domain/membership-state";

// ---------------------------------------------------------------------------
// lastAdminBlocks
// ---------------------------------------------------------------------------

describe("lastAdminBlocks", () => {
  it("returns true when adminCount is 1 (last admin — must block)", () => {
    expect(lastAdminBlocks(1)).toBe(true);
  });

  it("returns false when adminCount is 2 (safe to remove one)", () => {
    expect(lastAdminBlocks(2)).toBe(false);
  });

  it("returns false when adminCount is 3", () => {
    expect(lastAdminBlocks(3)).toBe(false);
  });

  it("returns true when adminCount is 0 (edge: no admins found — guard fires)", () => {
    // Defensive: if somehow 0 admins are counted, we must still block deletion
    expect(lastAdminBlocks(0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// inviteAcceptValidity
// ---------------------------------------------------------------------------

const BASE_NOW = new Date("2026-06-06T12:00:00.000Z");

const validInvite = {
  acceptedAt: null as Date | null,
  revokedAt: null as Date | null,
  expiresAt: new Date("2026-06-10T12:00:00.000Z"), // expires in the future
  invitedEmail: "user@example.com",
};

describe("inviteAcceptValidity — not found (null)", () => {
  it("returns not_found when invite is null", () => {
    const result = inviteAcceptValidity(null, BASE_NOW, "user@example.com");
    expect(result).toBe("not_found");
  });
});

describe("inviteAcceptValidity — already accepted", () => {
  it("returns already_accepted when acceptedAt is set", () => {
    const invite = { ...validInvite, acceptedAt: new Date("2026-06-05T10:00:00.000Z") };
    const result = inviteAcceptValidity(invite, BASE_NOW, "user@example.com");
    expect(result).toBe("already_accepted");
  });
});

describe("inviteAcceptValidity — revoked", () => {
  it("returns revoked when revokedAt is set", () => {
    const invite = { ...validInvite, revokedAt: new Date("2026-06-05T10:00:00.000Z") };
    const result = inviteAcceptValidity(invite, BASE_NOW, "user@example.com");
    expect(result).toBe("revoked");
  });
});

describe("inviteAcceptValidity — expired", () => {
  it("returns expired when expiresAt is in the past", () => {
    const invite = {
      ...validInvite,
      expiresAt: new Date("2026-06-01T12:00:00.000Z"), // past
    };
    const result = inviteAcceptValidity(invite, BASE_NOW, "user@example.com");
    expect(result).toBe("expired");
  });

  it("returns expired when expiresAt equals now (boundary — treat as expired)", () => {
    const invite = { ...validInvite, expiresAt: BASE_NOW };
    const result = inviteAcceptValidity(invite, BASE_NOW, "user@example.com");
    expect(result).toBe("expired");
  });
});

describe("inviteAcceptValidity — email mismatch", () => {
  it("returns email_mismatch when callerEmail differs (case-insensitive comparison)", () => {
    const result = inviteAcceptValidity(validInvite, BASE_NOW, "other@example.com");
    expect(result).toBe("email_mismatch");
  });

  it("returns valid when callerEmail matches with different casing", () => {
    // invitedEmail 'user@example.com', callerEmail 'USER@EXAMPLE.COM'
    const result = inviteAcceptValidity(validInvite, BASE_NOW, "USER@EXAMPLE.COM");
    expect(result).toBe("valid");
  });
});

describe("inviteAcceptValidity — valid", () => {
  it("returns valid when invite is active, not expired, and email matches", () => {
    const result = inviteAcceptValidity(validInvite, BASE_NOW, "user@example.com");
    expect(result).toBe("valid");
  });

  it("priority: acceptedAt check fires before revoked check (already_accepted wins)", () => {
    const invite = {
      ...validInvite,
      acceptedAt: new Date("2026-06-05T10:00:00.000Z"),
      revokedAt: new Date("2026-06-05T11:00:00.000Z"),
    };
    const result = inviteAcceptValidity(invite, BASE_NOW, "user@example.com");
    expect(result).toBe("already_accepted");
  });
});

// ---------------------------------------------------------------------------
// canDecide — grant state machine
// ---------------------------------------------------------------------------

describe("canDecide", () => {
  // pending → approved
  it("pending + approved decision is valid", () => {
    expect(canDecide("pending", "approved")).toBe(true);
  });

  // pending → denied
  it("pending + denied decision is valid", () => {
    expect(canDecide("pending", "denied")).toBe(true);
  });

  // approved → revoked
  it("approved + revoked decision is valid", () => {
    expect(canDecide("approved", "revoked")).toBe(true);
  });

  // denied → anything is terminal
  it("denied is a terminal state — cannot be decided further", () => {
    expect(canDecide("denied", "approved")).toBe(false);
    expect(canDecide("denied", "revoked")).toBe(false);
  });

  // revoked → anything is terminal
  it("revoked is a terminal state — cannot be decided further", () => {
    expect(canDecide("revoked", "approved")).toBe(false);
    expect(canDecide("revoked", "denied")).toBe(false);
  });

  // approved → approved is not valid (already approved)
  it("approved + approved decision is invalid (already in that state)", () => {
    expect(canDecide("approved", "approved")).toBe(false);
  });

  // approved → denied is invalid (spec: approved → revoked only)
  it("approved + denied decision is invalid (only revoked is valid from approved)", () => {
    expect(canDecide("approved", "denied")).toBe(false);
  });

  // pending → revoked is invalid (spec: pending → approved/denied only)
  it("pending + revoked is invalid (revoke only applies to approved grants)", () => {
    expect(canDecide("pending", "revoked")).toBe(false);
  });
});
