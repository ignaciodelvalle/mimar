// P4 — the pure rules of the finder's plan-B list and of the org's opt-in
// (design note docs/superpowers/specs/2026-10-p4-receptoras-cercanas.md).

import { describe, expect, it, vi } from "vitest";

import { lookupNearbyHelpForLocality } from "@/src/modules/organizations/application/find-nearby-help";
import { updateFoundAnimalIntake } from "@/src/modules/organizations/application/update-found-animal-intake";
import {
  FOUND_ANIMAL_INTAKE_OFF,
  canReceiveFoundAnimals,
  intakeContactHref,
  isListedReceiver,
  validateFoundAnimalIntake,
} from "@/src/modules/organizations/domain/found-animal-intake";
import {
  COARSE_GRID_DEGREES,
  NEARBY_RADIUS_KM,
  coarsenPoint,
  distanceLabel,
  isPlausibleArPoint,
  rankNearby,
} from "@/src/modules/organizations/domain/nearby-help";

describe("coarsenPoint — the only form a finder's place is queried in", () => {
  it("snaps both coordinates to the 0.01° grid", () => {
    expect(COARSE_GRID_DEGREES).toBe(0.01);
    expect(coarsenPoint({ lat: -34.578912, lng: -58.424377 })).toEqual({
      lat: -34.58,
      lng: -58.42,
    });
    expect(coarsenPoint({ lat: -34.574999, lng: -58.425001 })).toEqual({
      lat: -34.57,
      lng: -58.43,
    });
  });

  it("is idempotent and never keeps more than two decimals", () => {
    for (const p of [
      { lat: -31.4167321, lng: -64.1833211 },
      { lat: -54.8019, lng: -68.303 },
      { lat: -24.7821, lng: -65.4232 },
    ]) {
      const once = coarsenPoint(p);
      expect(coarsenPoint(once)).toEqual(once);
      expect(String(once.lat).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(2);
      expect(String(once.lng).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(2);
    }
  });

  it("accepts only points inside Argentina's box", () => {
    expect(isPlausibleArPoint({ lat: -34.6, lng: -58.4 })).toBe(true);
    expect(isPlausibleArPoint({ lat: 40.4, lng: -3.7 })).toBe(false);
    expect(isPlausibleArPoint({ lat: Number.NaN, lng: -58.4 })).toBe(false);
  });
});

describe("distanceLabel — coarse buckets, never a precise number", () => {
  it("hides anything under 2 km, rounds to the km up to 10, to 5 km beyond", () => {
    expect(distanceLabel(0.3)).toBe("a menos de 2 km");
    expect(distanceLabel(1.99)).toBe("a menos de 2 km");
    expect(distanceLabel(2.4)).toBe("a unos 2 km");
    expect(distanceLabel(3.4)).toBe("a unos 3 km");
    expect(distanceLabel(9.4)).toBe("a unos 9 km");
    expect(distanceLabel(12.4)).toBe("a unos 10 km");
    expect(distanceLabel(13)).toBe("a unos 15 km");
    expect(distanceLabel(48)).toBe("a unos 50 km");
  });
});

describe("rankNearby — the distance ordering", () => {
  const row = (displayName: string, distanceKm: number) => ({ displayName, distanceKm });

  it("orders nearest first, breaks ties by name, drops what is past the radius, caps the list", () => {
    const ranked = rankNearby(
      [
        row("Refugio Sur", 12),
        row("Red Norte", 3),
        row("Lejano", NEARBY_RADIUS_KM + 0.1),
        row("Ánimas", 3),
        row("Centro", 1),
        row("Oeste", 30),
        row("Este", 7),
      ],
      5,
    );
    expect(ranked.map((r) => r.displayName)).toEqual([
      "Centro",
      "Ánimas",
      "Red Norte",
      "Este",
      "Refugio Sur",
    ]);
  });

  it("drops a row whose distance could not be computed", () => {
    expect(rankNearby([row("Sin ubicación", Number.NaN), row("Con", 2)], 5)).toEqual([
      row("Con", 2),
    ]);
  });
});

describe("isListedReceiver — the pure twin of the public read's WHERE clause", () => {
  const base = { orgType: "shelter", verified: true, status: "active", accepting: true };

  it("lists a verified, active, opted-in org of an allowed type", () => {
    expect(isListedReceiver(base)).toBe(true);
    for (const orgType of ["shelter", "rescue_network", "clinic", "sanitary_authority"]) {
      expect(isListedReceiver({ ...base, orgType })).toBe(true);
    }
  });

  it("never lists an opted-out, unverified, suspended, dissolved or `other` org", () => {
    expect(isListedReceiver({ ...base, accepting: false })).toBe(false);
    expect(isListedReceiver({ ...base, verified: false })).toBe(false);
    expect(isListedReceiver({ ...base, status: "suspended" })).toBe(false);
    expect(isListedReceiver({ ...base, status: "dissolved" })).toBe(false);
    expect(isListedReceiver({ ...base, orgType: "other" })).toBe(false);
    expect(canReceiveFoundAnimals("other")).toBe(false);
  });
});

describe("validateFoundAnimalIntake", () => {
  const input = {
    accepting: true,
    capacityStatus: "recibimos",
    publicContactKind: null,
    publicContactValue: null,
    publicHours: null,
  };

  it("accepts the settings with no contact, and trims what it keeps", () => {
    expect(validateFoundAnimalIntake(input)).toEqual({
      ok: true,
      value: { ...FOUND_ANIMAL_INTAKE_OFF, accepting: true },
    });
    const r = validateFoundAnimalIntake({
      ...input,
      publicContactKind: "telefono",
      publicContactValue: "  011 4555-0000 ",
      publicHours: "  9 a 17 ",
    });
    expect(r).toEqual({
      ok: true,
      value: {
        accepting: true,
        capacityStatus: "recibimos",
        publicContactKind: "telefono",
        publicContactValue: "011 4555-0000",
        publicHours: "9 a 17",
      },
    });
  });

  it("refuses half a contact, an unknown status, a bad value and long hours", () => {
    expect(validateFoundAnimalIntake({ ...input, capacityStatus: "lleno" }).ok).toBe(false);
    expect(validateFoundAnimalIntake({ ...input, publicContactKind: "whatsapp" }).ok).toBe(false);
    expect(validateFoundAnimalIntake({ ...input, publicContactValue: "11 5555 0000" }).ok).toBe(
      false,
    );
    expect(
      validateFoundAnimalIntake({ ...input, publicContactKind: "fax", publicContactValue: "123" })
        .ok,
    ).toBe(false);
    expect(
      validateFoundAnimalIntake({
        ...input,
        publicContactKind: "email",
        publicContactValue: "no-es-mail",
      }).ok,
    ).toBe(false);
    expect(
      validateFoundAnimalIntake({
        ...input,
        publicContactKind: "web",
        publicContactValue: "javascript:alert(1)",
      }).ok,
    ).toBe(false);
    expect(validateFoundAnimalIntake({ ...input, publicHours: "x".repeat(121) }).ok).toBe(false);
  });

  it("turns a contact into a safe link, or none", () => {
    expect(intakeContactHref("telefono", "011 4555-0000")).toBe("tel:01145550000");
    expect(intakeContactHref("whatsapp", "+54 9 11 5555-0000")).toBe("https://wa.me/5491155550000");
    expect(intakeContactHref("email", "hola@refugio.org")).toBe("mailto:hola@refugio.org");
    expect(intakeContactHref("web", "https://refugio.org")).toBe("https://refugio.org");
    expect(intakeContactHref("web", "javascript:alert(1)")).toBeNull();
    expect(intakeContactHref("telefono", "llamar a Juan")).toBeNull();
  });
});

describe("lookupNearbyHelpForLocality — the rate limit comes first", () => {
  it("refuses an over-limit caller without reading anything", async () => {
    const executor = new Proxy(
      {},
      {
        get() {
          throw new Error("a throttled lookup must not read");
        },
      },
    ) as never;
    const isThrottled = vi.fn(async () => true);
    const result = await lookupNearbyHelpForLocality(
      { localityId: "00000000-0000-4000-8000-000000000000", includeVets: true },
      { isThrottled, executor },
    );
    expect(result).toEqual({ ok: false, error: "rate_limited" });
    expect(isThrottled).toHaveBeenCalledTimes(1);
  });

  it("refuses a malformed locality id after the limit, still without reading", async () => {
    const executor = new Proxy(
      {},
      {
        get() {
          throw new Error("a malformed id must not reach the database");
        },
      },
    ) as never;
    const result = await lookupNearbyHelpForLocality(
      { localityId: "-34.58,-58.42", includeVets: false },
      { isThrottled: async () => false, executor },
    );
    expect(result).toEqual({ ok: false, error: "invalid_place" });
  });
});

describe("updateFoundAnimalIntake — the admin re-check and the type rule", () => {
  const fields = {
    accepting: true,
    capacityStatus: "consultar",
    publicContactKind: "email",
    publicContactValue: "recepcion@refugio.org",
    publicHours: null,
  };
  const membership = (role: string, orgType: string) =>
    vi.fn(async () => ({
      org: { id: "org-1", orgType } as never,
      membership: { role } as never,
    }));

  it("an admin of an allowed type writes, attributed to themselves", async () => {
    const upsert = vi.fn(async () => {});
    const r = await updateFoundAnimalIntake(
      { userId: "user-1", orgToken: "DIM-ORG", fields },
      { repo: { findMembershipByUserAndOrgToken: membership("admin", "shelter") }, upsert },
    );
    expect(r.ok).toBe(true);
    expect(upsert).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ accepting: true, capacityStatus: "consultar" }),
      "user-1",
    );
  });

  it("a member, a non-member and an `other` org write nothing", async () => {
    for (const repo of [
      { findMembershipByUserAndOrgToken: membership("member", "shelter") },
      { findMembershipByUserAndOrgToken: vi.fn(async () => null) },
      { findMembershipByUserAndOrgToken: membership("admin", "other") },
    ]) {
      const upsert = vi.fn(async () => {});
      const r = await updateFoundAnimalIntake(
        { userId: "user-1", orgToken: "DIM-ORG", fields },
        { repo, upsert },
      );
      expect(r.ok).toBe(false);
      expect(upsert).not.toHaveBeenCalled();
    }
  });

  it("invalid input is refused before anything is read", async () => {
    const find = vi.fn(async () => null);
    const r = await updateFoundAnimalIntake(
      { userId: "user-1", orgToken: "DIM-ORG", fields: { ...fields, capacityStatus: "x" } },
      { repo: { findMembershipByUserAndOrgToken: find }, upsert: vi.fn() },
    );
    expect(r.ok).toBe(false);
    expect(find).not.toHaveBeenCalled();
  });
});
