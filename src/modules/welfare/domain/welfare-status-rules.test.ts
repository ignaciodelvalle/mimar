// Unit tests for welfare status state machine.
// Spec source: R3 — triage/start/close (welfare-triage.ts) state machine rules.
//
// State machine:
//   open        → triaged | in_progress | invalid | duplicate | closed
//   triaged     → in_progress | invalid | duplicate | closed
//   in_progress → closed
//   closed | invalid | duplicate → terminal (no re-open in v1)

import { describe, expect, it } from "vitest";

import {
  TERMINAL_STATUSES,
  isTerminalStatus,
  primaryWelfareAction,
  statusTransitionAllowed,
} from "./welfare-status-rules";

// ---------------------------------------------------------------------------
// statusTransitionAllowed — from "open"
// ---------------------------------------------------------------------------

describe("statusTransitionAllowed — from open", () => {
  it("allows open → triaged", () => {
    expect(statusTransitionAllowed("open", "triaged")).toBe(true);
  });

  it("allows open → in_progress", () => {
    expect(statusTransitionAllowed("open", "in_progress")).toBe(true);
  });

  it("allows open → invalid", () => {
    expect(statusTransitionAllowed("open", "invalid")).toBe(true);
  });

  it("allows open → duplicate", () => {
    expect(statusTransitionAllowed("open", "duplicate")).toBe(true);
  });

  it("allows open → closed", () => {
    expect(statusTransitionAllowed("open", "closed")).toBe(true);
  });

  it("denies open → open (no self-loop)", () => {
    expect(statusTransitionAllowed("open", "open")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// statusTransitionAllowed — from "triaged"
// ---------------------------------------------------------------------------

describe("statusTransitionAllowed — from triaged", () => {
  it("allows triaged → in_progress", () => {
    expect(statusTransitionAllowed("triaged", "in_progress")).toBe(true);
  });

  it("allows triaged → invalid", () => {
    expect(statusTransitionAllowed("triaged", "invalid")).toBe(true);
  });

  it("allows triaged → duplicate", () => {
    expect(statusTransitionAllowed("triaged", "duplicate")).toBe(true);
  });

  it("allows triaged → closed", () => {
    expect(statusTransitionAllowed("triaged", "closed")).toBe(true);
  });

  it("denies triaged → open (no rollback)", () => {
    expect(statusTransitionAllowed("triaged", "open")).toBe(false);
  });

  it("denies triaged → triaged (no self-loop)", () => {
    expect(statusTransitionAllowed("triaged", "triaged")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// statusTransitionAllowed — from "in_progress"
// ---------------------------------------------------------------------------

describe("statusTransitionAllowed — from in_progress", () => {
  it("allows in_progress → closed", () => {
    expect(statusTransitionAllowed("in_progress", "closed")).toBe(true);
  });

  it("denies in_progress → triaged (no rollback to triaged)", () => {
    expect(statusTransitionAllowed("in_progress", "triaged")).toBe(false);
  });

  it("denies in_progress → open", () => {
    expect(statusTransitionAllowed("in_progress", "open")).toBe(false);
  });

  it("denies in_progress → invalid", () => {
    expect(statusTransitionAllowed("in_progress", "invalid")).toBe(false);
  });

  it("denies in_progress → duplicate", () => {
    expect(statusTransitionAllowed("in_progress", "duplicate")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// statusTransitionAllowed — terminal statuses (all transitions denied)
// ---------------------------------------------------------------------------

describe("statusTransitionAllowed — from terminal statuses", () => {
  it("denies closed → anything", () => {
    expect(statusTransitionAllowed("closed", "open")).toBe(false);
    expect(statusTransitionAllowed("closed", "triaged")).toBe(false);
    expect(statusTransitionAllowed("closed", "in_progress")).toBe(false);
    expect(statusTransitionAllowed("closed", "closed")).toBe(false);
  });

  it("denies invalid → anything", () => {
    expect(statusTransitionAllowed("invalid", "open")).toBe(false);
    expect(statusTransitionAllowed("invalid", "triaged")).toBe(false);
    expect(statusTransitionAllowed("invalid", "closed")).toBe(false);
  });

  it("denies duplicate → anything", () => {
    expect(statusTransitionAllowed("duplicate", "open")).toBe(false);
    expect(statusTransitionAllowed("duplicate", "in_progress")).toBe(false);
    expect(statusTransitionAllowed("duplicate", "closed")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isTerminalStatus
// ---------------------------------------------------------------------------

describe("isTerminalStatus", () => {
  it("returns true for closed", () => {
    expect(isTerminalStatus("closed")).toBe(true);
  });

  it("returns true for invalid", () => {
    expect(isTerminalStatus("invalid")).toBe(true);
  });

  it("returns true for duplicate", () => {
    expect(isTerminalStatus("duplicate")).toBe(true);
  });

  it("returns false for open", () => {
    expect(isTerminalStatus("open")).toBe(false);
  });

  it("returns false for triaged", () => {
    expect(isTerminalStatus("triaged")).toBe(false);
  });

  it("returns false for in_progress", () => {
    expect(isTerminalStatus("in_progress")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TERMINAL_STATUSES constant
// ---------------------------------------------------------------------------

describe("TERMINAL_STATUSES", () => {
  it("contains closed, invalid, duplicate", () => {
    expect(TERMINAL_STATUSES).toContain("closed");
    expect(TERMINAL_STATUSES).toContain("invalid");
    expect(TERMINAL_STATUSES).toContain("duplicate");
  });

  it("does not contain open, triaged, or in_progress", () => {
    expect(TERMINAL_STATUSES).not.toContain("open");
    expect(TERMINAL_STATUSES).not.toContain("triaged");
    expect(TERMINAL_STATUSES).not.toContain("in_progress");
  });
});

// ---------------------------------------------------------------------------
// primaryWelfareAction — C6c workqueue grammar's row-level "Actuar" CTA
// ---------------------------------------------------------------------------

describe("primaryWelfareAction", () => {
  it("open → triage (first step of triage → en curso → resolución)", () => {
    expect(primaryWelfareAction("open")).toBe("triage");
  });

  it("triaged → start", () => {
    expect(primaryWelfareAction("triaged")).toBe("start");
  });

  it("in_progress → close", () => {
    expect(primaryWelfareAction("in_progress")).toBe("close");
  });

  it("returns null for every terminal status (no primary action left)", () => {
    expect(primaryWelfareAction("closed")).toBeNull();
    expect(primaryWelfareAction("invalid")).toBeNull();
    expect(primaryWelfareAction("duplicate")).toBeNull();
  });
});
