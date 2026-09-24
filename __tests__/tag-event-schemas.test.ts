// tag_activated / tag_revoked payload schemas (physical-tag-lifecycle).
//
// The load-bearing assertion here is the SECURITY one: the spine payloads must
// never carry the activation code under any field, so `.strict()` has to
// reject unknown keys — including the exact names a future writer would most
// plausibly leak (`code`, `activation_code`, `activation_code_hash`).

import { describe, expect, it } from "vitest";

import { validateEventPayload } from "@/lib/events/event-schemas";

describe("tag_activated schema", () => {
  it("accepts the canonical writer payload and fills payload_version", () => {
    const parsed = validateEventPayload("tag_activated", {
      serial: "TAG-ABCD-2345",
      lote_id: "LOTE-2026-08",
      source: "self",
    }) as Record<string, unknown>;
    expect(parsed.payload_version).toBe(1);
    expect(parsed.serial).toBe("TAG-ABCD-2345");
  });

  it("accepts a null lote_id (serial issued outside a batch)", () => {
    expect(() =>
      validateEventPayload("tag_activated", {
        serial: "TAG-ABCD-2345",
        lote_id: null,
        source: "self",
      }),
    ).not.toThrow();
  });

  it.each(["code", "activation_code", "activation_code_hash", "anything_extra"])(
    "rejects extra key %s (activation code can never reach the spine)",
    (key) => {
      expect(() =>
        validateEventPayload("tag_activated", {
          serial: "TAG-ABCD-2345",
          lote_id: null,
          source: "self",
          [key]: "WXYZ-6789",
        }),
      ).toThrow();
    },
  );

  it("rejects a non-self source (v1 is owner self-serve only)", () => {
    expect(() =>
      validateEventPayload("tag_activated", {
        serial: "TAG-ABCD-2345",
        lote_id: null,
        source: "admin",
      }),
    ).toThrow();
  });
});

describe("tag_revoked schema", () => {
  it("accepts the canonical writer payload", () => {
    expect(() =>
      validateEventPayload("tag_revoked", {
        serial: "TAG-ABCD-2345",
        revoke_reason: "transfer",
        replacement_serial: "TAG-EFGH-6789",
      }),
    ).not.toThrow();
  });

  it("uses revoke_reason, NOT reason (erase RPC sentinel-redacts `reason` on every type)", () => {
    expect(() =>
      validateEventPayload("tag_revoked", {
        serial: "TAG-ABCD-2345",
        reason: "lost",
        replacement_serial: null,
      }),
    ).toThrow();
  });

  it("rejects an out-of-enum revoke_reason", () => {
    expect(() =>
      validateEventPayload("tag_revoked", {
        serial: "TAG-ABCD-2345",
        revoke_reason: "because",
        replacement_serial: null,
      }),
    ).toThrow();
  });

  it.each(["code", "activation_code", "activation_code_hash"])("rejects extra key %s", (key) => {
    expect(() =>
      validateEventPayload("tag_revoked", {
        serial: "TAG-ABCD-2345",
        revoke_reason: "lost",
        replacement_serial: null,
        [key]: "WXYZ-6789",
      }),
    ).toThrow();
  });
});
