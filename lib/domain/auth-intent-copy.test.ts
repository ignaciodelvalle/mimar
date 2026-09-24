// Unit tests for getIntentCopy — pure function, no env required.

import { describe, expect, it } from "vitest";

import { getIntentCopy } from "@/lib/domain/auth-intent-copy";

describe("getIntentCopy", () => {
  it("returns null for null intent", () => {
    expect(getIntentCopy(null)).toBeNull();
  });

  it("returns null for undefined intent", () => {
    expect(getIntentCopy(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(getIntentCopy("")).toBeNull();
  });

  it("returns apply copy for intent=apply", () => {
    const copy = getIntentCopy("apply");
    expect(copy).not.toBeNull();
    expect(copy?.headline).toBeTruthy();
    expect(copy?.subcopy).toContain("postulación");
  });

  it("returns foster copy for intent=foster", () => {
    const copy = getIntentCopy("foster");
    expect(copy).not.toBeNull();
    expect(copy?.headline).toBeTruthy();
    expect(copy?.subcopy).toContain("tránsito");
  });

  it("returns generic copy for an unknown intent", () => {
    const copy = getIntentCopy("some-future-intent");
    expect(copy).not.toBeNull();
    expect(copy?.headline).toBeTruthy();
    expect(copy?.subcopy).toBeTruthy();
  });

  it("apply copy headline differs from foster copy headline", () => {
    const apply = getIntentCopy("apply");
    const foster = getIntentCopy("foster");
    expect(apply?.headline).not.toEqual(foster?.headline);
  });

  it("each known intent returns a subcopy that mentions why an account is needed", () => {
    for (const intent of ["apply", "foster"]) {
      const copy = getIntentCopy(intent);
      expect(copy?.subcopy.toLowerCase()).toContain("cuenta");
    }
  });
});
