// Tests for the service-dog presentation page helpers.
//
// The /asistencia/presentar route uses these pure-logic helpers so the
// guards and URL construction can be tested without a Next.js runtime.
// Commit 4 of pet-profile-v2 Slice C.

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildPublicVerifyUrl, isCredentialPresentable } from "@/lib/infra/service-dog-presentar";

describe("isCredentialPresentable", () => {
  it("returns true when credential is vigente and in service", () => {
    expect(isCredentialPresentable({ credentialStatus: "vigente", inService: true })).toBe(true);
  });

  it("returns false when credential is not vigente", () => {
    expect(isCredentialPresentable({ credentialStatus: "vencida", inService: true })).toBe(false);
    expect(isCredentialPresentable({ credentialStatus: "revocada", inService: true })).toBe(false);
    expect(
      isCredentialPresentable({ credentialStatus: "pendiente_verificacion", inService: true }),
    ).toBe(false);
    expect(isCredentialPresentable({ credentialStatus: "en_entrenamiento", inService: true })).toBe(
      false,
    );
  });

  it("returns false when inService is false even if vigente", () => {
    expect(isCredentialPresentable({ credentialStatus: "vigente", inService: false })).toBe(false);
  });

  it("returns false when no service dog row exists (null)", () => {
    expect(isCredentialPresentable(null)).toBe(false);
  });
});

describe("buildPublicVerifyUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds an ABSOLUTE public verify URL from a publicToken (QR payload)", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://www.mimar.gob.ar");
    const url = buildPublicVerifyUrl("abc123");
    expect(url).toBe("https://www.mimar.gob.ar/p/abc123");
  });

  it("stays absolute on the canonical fallback when the env var is unset/empty", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    const url = buildPublicVerifyUrl("abc123");
    expect(url.startsWith("http")).toBe(true);
    // Pinned to the literal the resolver actually falls back to, moved off
    // `https://mimar.ar` on 2026-09-07 — that domain does not exist, so this
    // assertion was pinning an unscannable QR payload for a service dog's
    // public verification page, the one surface a business owner is asked to
    // check on the spot.
    expect(url).toBe("https://www.mimar.com.ar/p/abc123");
  });

  it("handles tokens with special chars in the path segment", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://www.mimar.com.ar");
    const url = buildPublicVerifyUrl("tok-xyz_789");
    expect(url).toBe("https://www.mimar.com.ar/p/tok-xyz_789");
  });
});
