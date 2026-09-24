// Unit tests for validateReversalInput — pure, no DB.

import { describe, expect, it } from "vitest";
import { validateReversalInput } from "../reversal-rules";

describe("validateReversalInput", () => {
  it("accepts a null reason", () => {
    const result = validateReversalInput({ reason: null });
    expect(result).toEqual({ ok: true });
  });

  it("accepts a short reason", () => {
    const result = validateReversalInput({ reason: "El adoptante devolvió el animal." });
    expect(result).toEqual({ ok: true });
  });

  it("accepts a reason at exactly the length limit (500 chars)", () => {
    const result = validateReversalInput({ reason: "a".repeat(500) });
    expect(result).toEqual({ ok: true });
  });

  it("rejects a reason over the length limit (501 chars)", () => {
    const result = validateReversalInput({ reason: "a".repeat(501) });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/500 caracteres/i);
  });
});
