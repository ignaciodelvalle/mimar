// Unit tests for cross-org-rules.ts — pure, no DB.
// Written FIRST (RED phase, task 1.3) before creating cross-org-rules.ts.

import { describe, expect, it } from "vitest";

import {
  validateCrossOrgReason,
  validateDuplicateProposalGuard,
  validateOrgTokenMatch,
  validateReceiverNotSender,
  validateReceiverOrgScope,
  validateSenderOrgScope,
} from "../cross-org-rules";

// ---------------------------------------------------------------------------
// validateCrossOrgReason
// ---------------------------------------------------------------------------

describe("validateCrossOrgReason", () => {
  it("accepts 'space_constraint'", () => {
    expect(validateCrossOrgReason({ reason: "space_constraint", notes: null })).toMatchObject({
      ok: true,
    });
  });

  it("accepts 'specialization_needed'", () => {
    expect(validateCrossOrgReason({ reason: "specialization_needed", notes: null })).toMatchObject({
      ok: true,
    });
  });

  it("accepts 'network_redistribution'", () => {
    expect(validateCrossOrgReason({ reason: "network_redistribution", notes: null })).toMatchObject(
      { ok: true },
    );
  });

  it("accepts 'shelter_closing'", () => {
    expect(validateCrossOrgReason({ reason: "shelter_closing", notes: null })).toMatchObject({
      ok: true,
    });
  });

  it("accepts 'post_adoption_failed_return'", () => {
    expect(
      validateCrossOrgReason({ reason: "post_adoption_failed_return", notes: null }),
    ).toMatchObject({ ok: true });
  });

  it("accepts 'other' with notes", () => {
    expect(validateCrossOrgReason({ reason: "other", notes: "some explanation" })).toMatchObject({
      ok: true,
    });
  });

  it("rejects 'other' without notes", () => {
    expect(validateCrossOrgReason({ reason: "other", notes: null })).toMatchObject({
      ok: false,
      error: expect.stringContaining("nota"),
    });
  });

  it("rejects 'other' with empty notes string", () => {
    expect(validateCrossOrgReason({ reason: "other", notes: "   " })).toMatchObject({
      ok: false,
    });
  });

  it("rejects an invalid reason", () => {
    expect(validateCrossOrgReason({ reason: "bad", notes: null })).toMatchObject({
      ok: false,
      error: expect.stringContaining("inválido"),
    });
  });
});

// ---------------------------------------------------------------------------
// validateReceiverNotSender
// ---------------------------------------------------------------------------

describe("validateReceiverNotSender", () => {
  it("passes when receiver and sender are different orgs", () => {
    expect(validateReceiverNotSender("org-a", "org-b")).toMatchObject({ ok: true });
  });

  it("fails when receiver equals sender", () => {
    expect(validateReceiverNotSender("org-a", "org-a")).toMatchObject({
      ok: false,
      error: expect.stringContaining("destinatario"),
    });
  });
});

// ---------------------------------------------------------------------------
// validateOrgTokenMatch (sender-side, cross-org propose)
// ---------------------------------------------------------------------------

describe("validateOrgTokenMatch (propose)", () => {
  it("passes when the org token matches", () => {
    expect(validateOrgTokenMatch("tok-123", "tok-123", "sender")).toMatchObject({ ok: true });
  });

  it("fails for sender mismatch with correct error", () => {
    expect(validateOrgTokenMatch("tok-abc", "tok-xyz", "sender")).toMatchObject({
      ok: false,
      error: expect.stringContaining("sender"),
    });
  });

  it("fails for receiver mismatch with correct error", () => {
    expect(validateOrgTokenMatch("tok-abc", "tok-xyz", "receiver")).toMatchObject({
      ok: false,
      error: expect.stringContaining("receiver"),
    });
  });
});

// ---------------------------------------------------------------------------
// validateSenderOrgScope (canonical sender = case col ?? payload)
// ---------------------------------------------------------------------------

describe("validateSenderOrgScope", () => {
  it("resolves sender from case column when available", () => {
    const result = validateSenderOrgScope({
      caseOpenedByOrganizationId: "org-sender",
      payloadFromOrganizationId: "org-sender",
    });
    expect(result).toMatchObject({ ok: true, value: { canonicalSenderOrgId: "org-sender" } });
  });

  it("falls back to payload when case column is null", () => {
    const result = validateSenderOrgScope({
      caseOpenedByOrganizationId: null,
      payloadFromOrganizationId: "org-sender",
    });
    expect(result).toMatchObject({ ok: true, value: { canonicalSenderOrgId: "org-sender" } });
  });

  it("returns inconsistency error when case column and payload disagree (drift detection)", () => {
    const result = validateSenderOrgScope({
      caseOpenedByOrganizationId: "org-a",
      payloadFromOrganizationId: "org-b",
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Inconsistencia") });
  });

  it("fails when neither source has sender org", () => {
    const result = validateSenderOrgScope({
      caseOpenedByOrganizationId: null,
      payloadFromOrganizationId: undefined,
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("emisora") });
  });
});

// ---------------------------------------------------------------------------
// validateReceiverOrgScope (canonical receiver = case col ?? payload) — SECURITY BOUNDARY
// ---------------------------------------------------------------------------

describe("validateReceiverOrgScope", () => {
  it("resolves receiver from case column when both agree", () => {
    const result = validateReceiverOrgScope({
      caseReceiverOrganizationId: "org-recv",
      payloadToOrganizationId: "org-recv",
      callerOrgId: "org-recv",
    });
    expect(result).toMatchObject({
      ok: true,
      value: { canonicalReceiverOrgId: "org-recv" },
    });
  });

  it("falls back to payload when case column is null", () => {
    const result = validateReceiverOrgScope({
      caseReceiverOrganizationId: null,
      payloadToOrganizationId: "org-recv",
      callerOrgId: "org-recv",
    });
    expect(result).toMatchObject({ ok: true, value: { canonicalReceiverOrgId: "org-recv" } });
  });

  it("returns inconsistency error when case column and payload disagree (drift detection)", () => {
    const result = validateReceiverOrgScope({
      caseReceiverOrganizationId: "org-a",
      payloadToOrganizationId: "org-b",
      callerOrgId: "org-a",
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Inconsistencia") });
  });

  it("fails when canonical receiver does not match caller (auth boundary)", () => {
    const result = validateReceiverOrgScope({
      caseReceiverOrganizationId: "org-a",
      payloadToOrganizationId: "org-a",
      callerOrgId: "org-b",
    });
    expect(result).toMatchObject({
      ok: false,
      error: "La propuesta no fue dirigida a tu organización.",
    });
  });

  it("fails when no receiver org can be resolved", () => {
    const result = validateReceiverOrgScope({
      caseReceiverOrganizationId: null,
      payloadToOrganizationId: undefined,
      callerOrgId: "org-b",
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("destinataria") });
  });
});

// ---------------------------------------------------------------------------
// validateDuplicateProposalGuard (LIMIT-2, fail-loud)
// ---------------------------------------------------------------------------

describe("validateDuplicateProposalGuard", () => {
  it("passes when exactly one proposal event exists", () => {
    expect(validateDuplicateProposalGuard(1)).toMatchObject({ ok: true });
  });

  it("fails with loud error when zero events (no proposal found)", () => {
    expect(validateDuplicateProposalGuard(0)).toMatchObject({
      ok: false,
      error: expect.stringContaining("no encontrada"),
    });
  });

  it("fails with loud duplicate error when two events found (shadow proposal)", () => {
    expect(validateDuplicateProposalGuard(2)).toMatchObject({
      ok: false,
      error: expect.stringContaining("duplicadas"),
    });
  });
});
