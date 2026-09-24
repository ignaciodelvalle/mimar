// Lote A4 — the server-side mirror of the attestation form's registry options.
// What these tests defend: the form and the action derive their sets from the
// SAME rule payload, so a jurisdiction override can never make the client
// offer a registry the server rejects (or vice versa).

import { describe, expect, it } from "vitest";

import { DANGEROUS_BREED_REGISTRIES, allowedAttestationRegistries } from "./enums";

describe("allowedAttestationRegistries (A4)", () => {
  it("no override (empty rule) → the national fallback list plus 'other'", () => {
    const allowed = allowedAttestationRegistries({ registries: [] });
    for (const id of DANGEROUS_BREED_REGISTRIES) {
      expect(allowed.has(id)).toBe(true);
    }
    expect(allowed.has("not_a_registry")).toBe(false);
  });

  it("a jurisdiction override REPLACES the fallback — its ids are accepted", () => {
    const allowed = allowedAttestationRegistries({
      registries: [{ id: "custom_registry_x" }],
    });
    expect(allowed.has("custom_registry_x")).toBe(true);
  });

  it("an override also RETIRES the old hardcoded ids (split-brain closed both ways)", () => {
    const allowed = allowedAttestationRegistries({
      registries: [{ id: "custom_registry_x" }],
    });
    expect(allowed.has("caba_4078")).toBe(false);
    expect(allowed.has("prov_14107")).toBe(false);
  });

  it("'other' is always accepted, override or not", () => {
    expect(allowedAttestationRegistries({ registries: [] }).has("other")).toBe(true);
    expect(
      allowedAttestationRegistries({ registries: [{ id: "custom_registry_x" }] }).has("other"),
    ).toBe(true);
  });
});
