import { describe, expect, it } from "vitest";

import { type EmergencyContactLevel, resolveEmergencyContacts } from "./emergency-contacts";

const EMPTY: EmergencyContactLevel = {
  preferredVetName: null,
  preferredVetPhone: null,
  emergencyContactName: null,
  emergencyContactPhone: null,
};

describe("resolveEmergencyContacts — per-pet override + account default (P2)", () => {
  it("returns null pairs when neither level has any value", () => {
    expect(resolveEmergencyContacts(EMPTY, EMPTY)).toEqual({ vet: null, emergency: null });
  });

  it("uses the account default when the pet has no override", () => {
    const account: EmergencyContactLevel = {
      preferredVetName: "Dr. Cuenta",
      preferredVetPhone: "111",
      emergencyContactName: "Tía Ana",
      emergencyContactPhone: "222",
    };
    expect(resolveEmergencyContacts(EMPTY, account)).toEqual({
      vet: { name: "Dr. Cuenta", phone: "111", source: "account" },
      emergency: { name: "Tía Ana", phone: "222", source: "account" },
    });
  });

  it("prefers the pet override over the account default", () => {
    const pet: EmergencyContactLevel = {
      preferredVetName: "Dra. Pet",
      preferredVetPhone: "999",
      emergencyContactName: null,
      emergencyContactPhone: null,
    };
    const account: EmergencyContactLevel = {
      preferredVetName: "Dr. Cuenta",
      preferredVetPhone: "111",
      emergencyContactName: "Tía Ana",
      emergencyContactPhone: "222",
    };
    const resolved = resolveEmergencyContacts(pet, account);
    // Vet: pet override wins.
    expect(resolved.vet).toEqual({ name: "Dra. Pet", phone: "999", source: "pet" });
    // Emergency: pet blank → account fallback.
    expect(resolved.emergency).toEqual({ name: "Tía Ana", phone: "222", source: "account" });
  });

  it("resolves each row at the PAIR level (a pet phone-only override does not pull the account name)", () => {
    const pet: EmergencyContactLevel = {
      ...EMPTY,
      preferredVetPhone: "999",
    };
    const account: EmergencyContactLevel = {
      ...EMPTY,
      preferredVetName: "Dr. Cuenta",
      preferredVetPhone: "111",
    };
    // Because the pet has a phone, the whole vet row comes from the pet — name
    // stays null rather than mixing in the account's name.
    expect(resolveEmergencyContacts(pet, account).vet).toEqual({
      name: null,
      phone: "999",
      source: "pet",
    });
  });

  it("treats whitespace-only pet values as absent (falls back to account)", () => {
    const pet: EmergencyContactLevel = { ...EMPTY, preferredVetName: "   ", preferredVetPhone: "" };
    const account: EmergencyContactLevel = {
      ...EMPTY,
      preferredVetName: "Dr. Cuenta",
      preferredVetPhone: "111",
    };
    expect(resolveEmergencyContacts(pet, account).vet).toEqual({
      name: "Dr. Cuenta",
      phone: "111",
      source: "account",
    });
  });

  it("trims resolved values", () => {
    const pet: EmergencyContactLevel = {
      ...EMPTY,
      emergencyContactName: "  Ana  ",
      emergencyContactPhone: "  222  ",
    };
    expect(resolveEmergencyContacts(pet, EMPTY).emergency).toEqual({
      name: "Ana",
      phone: "222",
      source: "pet",
    });
  });
});
