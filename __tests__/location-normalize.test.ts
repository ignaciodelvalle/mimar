// Unit tests for normalizeLocationForWrite (P2 gate).
//
// Tests cover:
//   1. Province canonicalization via ISO code.
//   2. locality:"none" — no catalog lookup; raw locality passed through.
//   3. locality:"strict" — throws JurisdictionValidationError on unknown locality.
//   4. locality:"soft" — passes raw through on miss; resolves on hit.
//   5. requireCoords:true — throws CoordError when coords absent.
//   6. Coord range check — throws CoordError for lat > 90, lng < -180.
//   7. Coord range check — passes for valid in-range coords.
//   8. No coord error when coords absent and requireCoords is false (default).

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock: jurisdiction-validation
// ---------------------------------------------------------------------------

const mockResolveCanonicalJurisdiction = vi.hoisted(() => vi.fn());
const mockResolveUniqueJurisdiction = vi.hoisted(() => vi.fn());
const mockResolveCanonicalJurisdictionById = vi.hoisted(() => vi.fn());
const mockTryResolveCanonicalJurisdiction = vi.hoisted(() => vi.fn());
const MockJurisdictionValidationError = vi.hoisted(
  () =>
    class extends Error {
      code: string;
      constructor(code: string, message: string) {
        super(message);
        this.name = "JurisdictionValidationError";
        this.code = code;
      }
    },
);

vi.mock("@/lib/infra/jurisdiction-validation", () => ({
  resolveCanonicalJurisdiction: mockResolveCanonicalJurisdiction,
  resolveUniqueJurisdiction: mockResolveUniqueJurisdiction,
  resolveCanonicalJurisdictionById: mockResolveCanonicalJurisdictionById,
  tryResolveCanonicalJurisdiction: mockTryResolveCanonicalJurisdiction,
  JurisdictionValidationError: MockJurisdictionValidationError,
}));

// ---------------------------------------------------------------------------
// Mock: jurisdiction-canonical
// ---------------------------------------------------------------------------

vi.mock("@/lib/domain/jurisdiction-canonical", () => ({
  canonicalProvinceNameForStorage: vi.fn((input: string | null | undefined) => {
    if (!input) return null;
    // Minimal simulation: ISO AR-B → "Buenos Aires", display name passthrough.
    if (input === "AR-B") return "Buenos Aires";
    if (input === "AR-C") return "CABA";
    // Return input as-is for other non-empty strings to simulate display name acceptance.
    return input.trim() || null;
  }),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import {
  CoordError,
  JurisdictionValidationError,
  normalizeLocationForWrite,
} from "@/lib/domain/location-normalize";
import type { LocationValue } from "@/lib/domain/location-value";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLocationValue(overrides: Partial<LocationValue> = {}): LocationValue {
  return {
    province: null,
    provinceCode: null,
    locality: null,
    localityIndecId: null,
    lat: null,
    lng: null,
    address: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("normalizeLocationForWrite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // A2-alta-asentar-03 — the INDEC id decides which homonym this is
  // -------------------------------------------------------------------------
  //
  // `localityByName` resolves a (province, name) pair with
  // `.orderBy(departmentName).limit(1)`, and the catalogue ships 68 collisions.
  // So the picker showed two "San Martín" rows with different departments, the
  // person tapped the second, and the pet was stored in the first. Jurisdiction
  // decides the responding authority, the PPP regime and the epidemiological
  // attribution. `LocationValue.localityIndecId` existed from the start and this
  // function never read it (14-4, still open) — every caller passed null.
  describe("locality resolution by INDEC id", () => {
    const SAN_MARTIN_MENDOZA = {
      province: { name: "Mendoza", code: "AR-M" },
      locality: { id: "uuid-mendoza", localityName: "San Martín", provinceCode: "AR-M" },
    };

    it("resolves by id instead of by name when the caller sends one", async () => {
      mockResolveCanonicalJurisdictionById.mockResolvedValue(SAN_MARTIN_MENDOZA);

      const result = await normalizeLocationForWrite(
        makeLocationValue({
          provinceCode: "Mendoza",
          locality: "San Martín",
          localityIndecId: "500098",
        }),
        { locality: "strict" },
      );

      expect(mockResolveCanonicalJurisdictionById).toHaveBeenCalledWith({ indecId: "500098" });
      // THE NAME LOOKUP MUST NOT RUN. It is the one that picks the wrong row.
      expect(mockResolveCanonicalJurisdiction).not.toHaveBeenCalled();
      expect(mockResolveUniqueJurisdiction).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        province: "Mendoza",
        locality: "San Martín",
        localityCanonical: true,
        localityId: "uuid-mendoza",
        placeMethod: "indec_id",
      });
    });

    it("refuses a body whose id names a locality in a DIFFERENT province", async () => {
      // The id is the authority for WHICH locality, not a licence to overrule
      // the province the caller named: a client whose two halves disagree is
      // broken or hostile, and storing the id's province silently would let it
      // attribute a pet to a jurisdiction it never claimed.
      mockResolveCanonicalJurisdictionById.mockResolvedValue(SAN_MARTIN_MENDOZA);

      await expect(
        normalizeLocationForWrite(
          makeLocationValue({
            provinceCode: "AR-B",
            locality: "San Martín",
            localityIndecId: "500098",
          }),
          { locality: "strict" },
        ),
      ).rejects.toThrow(JurisdictionValidationError);
    });

    it("falls back to the NAME path in soft mode when the id is unknown", async () => {
      // A stale id must not break a write that "soft" exists to let through.
      mockResolveCanonicalJurisdictionById.mockRejectedValue(
        new MockJurisdictionValidationError("INVALID_LOCALITY", "no such id"),
      );
      mockTryResolveCanonicalJurisdiction.mockResolvedValue({
        province: "Buenos Aires",
        locality: "San Martín",
        canonical: true,
        localityId: "uuid-ba",
      });

      const result = await normalizeLocationForWrite(
        makeLocationValue({
          provinceCode: "AR-B",
          locality: "San Martín",
          localityIndecId: "no-existe",
        }),
        { locality: "soft" },
      );

      expect(mockTryResolveCanonicalJurisdiction).toHaveBeenCalled();
      expect(result.locality).toBe("San Martín");
    });

    it("REFUSES an unknown id in strict mode rather than falling back", async () => {
      // Falling back here would resolve the name and land on the wrong
      // department — the exact behaviour the id exists to replace.
      mockResolveCanonicalJurisdictionById.mockRejectedValue(
        new MockJurisdictionValidationError("INVALID_LOCALITY", "no such id"),
      );

      await expect(
        normalizeLocationForWrite(
          makeLocationValue({
            provinceCode: "AR-B",
            locality: "San Martín",
            localityIndecId: "no-existe",
          }),
          { locality: "strict" },
        ),
      ).rejects.toThrow(JurisdictionValidationError);
      expect(mockResolveUniqueJurisdiction).not.toHaveBeenCalled();
    });

    it("ignores a blank id and every id under locality:none", async () => {
      // NON-VACUITY: the id path must not have taken over the two cases that
      // were working. A blank string is what an older client's draft holds.
      mockResolveUniqueJurisdiction.mockResolvedValue({
        province: { name: "Buenos Aires" },
        locality: { id: "uuid-ba", localityName: "San Martín" },
        method: "exact_name_unique",
      });

      await normalizeLocationForWrite(
        makeLocationValue({ provinceCode: "AR-B", locality: "San Martín", localityIndecId: "  " }),
        { locality: "strict" },
      );
      expect(mockResolveUniqueJurisdiction).toHaveBeenCalled();
      expect(mockResolveCanonicalJurisdictionById).not.toHaveBeenCalled();

      const none = await normalizeLocationForWrite(
        makeLocationValue({
          provinceCode: "AR-B",
          locality: "San Martín",
          localityIndecId: "500098",
        }),
        { locality: "none" },
      );
      expect(mockResolveCanonicalJurisdictionById).not.toHaveBeenCalled();
      expect(none.localityCanonical).toBe(false);
    });
  });

  describe("province canonicalization", () => {
    it("converts ISO provinceCode to canonical display name", async () => {
      const result = await normalizeLocationForWrite(makeLocationValue({ provinceCode: "AR-B" }), {
        locality: "none",
      });
      expect(result.province).toBe("Buenos Aires");
    });

    it("passes display name through when provinceCode is absent", async () => {
      const result = await normalizeLocationForWrite(makeLocationValue({ province: "Mendoza" }), {
        locality: "none",
      });
      expect(result.province).toBe("Mendoza");
    });

    it("returns null province for empty inputs", async () => {
      const result = await normalizeLocationForWrite(makeLocationValue(), { locality: "none" });
      expect(result.province).toBeNull();
    });
  });

  describe('locality:"none"', () => {
    it("passes raw locality through without catalog lookup", async () => {
      const result = await normalizeLocationForWrite(
        makeLocationValue({ provinceCode: "AR-B", locality: "La Plata" }),
        { locality: "none" },
      );
      expect(result.locality).toBe("La Plata");
      expect(result.localityCanonical).toBe(false);
      expect(result.placeMethod).toBe("unresolved");
      expect(mockResolveUniqueJurisdiction).not.toHaveBeenCalled();
      expect(mockTryResolveCanonicalJurisdiction).not.toHaveBeenCalled();
    });
  });

  describe('locality:"strict"', () => {
    it("returns canonical locality + the resolved locality id on successful resolution", async () => {
      mockResolveUniqueJurisdiction.mockResolvedValue({
        province: { name: "Buenos Aires" },
        locality: { localityName: "La Plata", id: "loc-la-plata-uuid" },
        method: "folded_name_unique",
      });

      const result = await normalizeLocationForWrite(
        makeLocationValue({ provinceCode: "AR-B", locality: "la plata" }),
        { locality: "strict" },
      );

      expect(result.province).toBe("Buenos Aires");
      expect(result.locality).toBe("La Plata");
      expect(result.localityCanonical).toBe(true);
      // Thread-B: the resolved catalog id (the new FK value every write site
      // persists) is returned, not discarded.
      expect(result.localityId).toBe("loc-la-plata-uuid");
      // HOW it resolved travels with it: "la plata" is not the catalogue's
      // spelling, so this is a folded match, not an exact one.
      expect(result.placeMethod).toBe("folded_name_unique");
    });

    it("returns a null locality id when the locality does not resolve to the catalog", async () => {
      const result = await normalizeLocationForWrite(makeLocationValue({ provinceCode: "AR-B" }), {
        locality: "strict",
      });
      expect(result.localityId).toBeNull();
    });

    it("throws JurisdictionValidationError on unknown locality", async () => {
      mockResolveUniqueJurisdiction.mockRejectedValue(
        new MockJurisdictionValidationError("INVALID_LOCALITY", "Localidad no encontrada."),
      );

      await expect(
        normalizeLocationForWrite(makeLocationValue({ provinceCode: "AR-B", locality: "Narnia" }), {
          locality: "strict",
        }),
      ).rejects.toBeInstanceOf(JurisdictionValidationError);
    });

    it("skips strict resolution when locality is absent", async () => {
      const result = await normalizeLocationForWrite(makeLocationValue({ provinceCode: "AR-B" }), {
        locality: "strict",
      });
      expect(result.locality).toBeNull();
      expect(mockResolveUniqueJurisdiction).not.toHaveBeenCalled();
    });

    // localidades-por-id A9 — the NAME path resolves only a name that names ONE
    // catalogue row. `resolveCanonicalJurisdiction` settles a homonym by taking
    // the alphabetically first department; the gate must never reach it.
    it("resolves names through the unique resolver, never the first-department one", async () => {
      mockResolveUniqueJurisdiction.mockResolvedValue({
        province: { name: "Buenos Aires" },
        locality: { localityName: "La Plata", id: "loc-la-plata-uuid" },
        method: "exact_name_unique",
      });
      await normalizeLocationForWrite(
        makeLocationValue({ provinceCode: "AR-B", locality: "La Plata" }),
        { locality: "strict" },
      );
      expect(mockResolveUniqueJurisdiction).toHaveBeenCalledWith({
        rawProvince: "Buenos Aires",
        rawLocality: "La Plata",
      });
      expect(mockResolveCanonicalJurisdiction).not.toHaveBeenCalled();
    });

    it("refuses an ambiguous name instead of filing it under either homonym", async () => {
      mockResolveUniqueJurisdiction.mockRejectedValue(
        new MockJurisdictionValidationError(
          "AMBIGUOUS_LOCALITY",
          "Hay más de una localidad llamada Mechita en Buenos Aires.",
        ),
      );
      await expect(
        normalizeLocationForWrite(
          makeLocationValue({ provinceCode: "AR-B", locality: "Mechita" }),
          {
            locality: "strict",
          },
        ),
      ).rejects.toMatchObject({ code: "AMBIGUOUS_LOCALITY" });
    });
  });

  describe('locality:"soft"', () => {
    it("returns canonical locality when resolved", async () => {
      mockTryResolveCanonicalJurisdiction.mockResolvedValue({
        province: "Buenos Aires",
        locality: "La Plata",
        canonical: true,
        localityId: "loc-la-plata-uuid",
        ambiguous: false,
        method: "folded_name_unique",
      });

      const result = await normalizeLocationForWrite(
        makeLocationValue({ provinceCode: "AR-B", locality: "la plata" }),
        { locality: "soft" },
      );

      expect(result.locality).toBe("La Plata");
      expect(result.localityCanonical).toBe(true);
      expect(result.placeMethod).toBe("folded_name_unique");
    });

    // localidades-por-id A9 — soft must never block a report, and must never
    // pick a homonym either. An ambiguous name keeps the PROVINCE and stores
    // no locality: a province-level place the province's authority sees, and
    // not a name every same-named municipality's grant would match.
    it("stores an ambiguous name as a province-level place, never either homonym", async () => {
      mockTryResolveCanonicalJurisdiction.mockResolvedValue({
        province: "Buenos Aires",
        locality: "Mechita",
        canonical: false,
        localityId: null,
        ambiguous: true,
        method: "unresolved",
      });

      const result = await normalizeLocationForWrite(
        makeLocationValue({ provinceCode: "AR-B", locality: "Mechita" }),
        { locality: "soft" },
      );

      expect(result).toMatchObject({
        province: "Buenos Aires",
        locality: null,
        localityCanonical: false,
        localityId: null,
        placeMethod: "unresolved",
      });
    });

    it("falls back to raw locality when catalog miss", async () => {
      mockTryResolveCanonicalJurisdiction.mockResolvedValue({
        province: "Buenos Aires",
        locality: "Localidad Rara",
        canonical: false,
        localityId: null,
        ambiguous: false,
        method: "unresolved",
      });

      const result = await normalizeLocationForWrite(
        makeLocationValue({ provinceCode: "AR-B", locality: "Localidad Rara" }),
        { locality: "soft" },
      );

      expect(result.locality).toBe("Localidad Rara");
      expect(result.localityCanonical).toBe(false);
      expect(result.placeMethod).toBe("unresolved");
    });
  });

  describe("requireCoords:true", () => {
    it("throws CoordError COORD_REQUIRED when lat/lng are null", async () => {
      await expect(
        normalizeLocationForWrite(makeLocationValue(), { locality: "none", requireCoords: true }),
      ).rejects.toMatchObject({ code: "COORD_REQUIRED" });
    });

    it("throws CoordError COORD_REQUIRED when coords are non-finite (NaN)", async () => {
      await expect(
        normalizeLocationForWrite(makeLocationValue({ lat: Number.NaN, lng: Number.NaN }), {
          locality: "none",
          requireCoords: true,
        }),
      ).rejects.toMatchObject({ code: "COORD_REQUIRED" });
    });

    it("resolves when valid coords are present", async () => {
      const result = await normalizeLocationForWrite(
        makeLocationValue({ lat: -34.6037, lng: -58.3816 }),
        { locality: "none", requireCoords: true },
      );
      expect(result.lat).toBe(-34.6037);
      expect(result.lng).toBe(-58.3816);
    });
  });

  describe("coord range check (always applied when coords present)", () => {
    it("throws CoordError COORD_OUT_OF_RANGE for lat > 90", async () => {
      await expect(
        normalizeLocationForWrite(makeLocationValue({ lat: 91, lng: 0 }), { locality: "none" }),
      ).rejects.toMatchObject({ code: "COORD_OUT_OF_RANGE" });
    });

    it("throws CoordError COORD_OUT_OF_RANGE for lat < -90", async () => {
      await expect(
        normalizeLocationForWrite(makeLocationValue({ lat: -91, lng: 0 }), { locality: "none" }),
      ).rejects.toMatchObject({ code: "COORD_OUT_OF_RANGE" });
    });

    it("throws CoordError COORD_OUT_OF_RANGE for lng > 180", async () => {
      await expect(
        normalizeLocationForWrite(makeLocationValue({ lat: 0, lng: 181 }), { locality: "none" }),
      ).rejects.toMatchObject({ code: "COORD_OUT_OF_RANGE" });
    });

    it("throws CoordError COORD_OUT_OF_RANGE for lng < -180", async () => {
      await expect(
        normalizeLocationForWrite(makeLocationValue({ lat: 0, lng: -181 }), { locality: "none" }),
      ).rejects.toMatchObject({ code: "COORD_OUT_OF_RANGE" });
    });

    it("accepts boundary values exactly at range", async () => {
      const result = await normalizeLocationForWrite(makeLocationValue({ lat: -90, lng: 180 }), {
        locality: "none",
      });
      expect(result.lat).toBe(-90);
      expect(result.lng).toBe(180);
    });

    it("does not throw for absent coords (requireCoords defaults to false)", async () => {
      const result = await normalizeLocationForWrite(makeLocationValue(), { locality: "none" });
      expect(result.lat).toBeNull();
      expect(result.lng).toBeNull();
    });
  });

  describe("the locality mode is mandatory (L0·1, 2026-09-08)", () => {
    it("refuses, at compile time, a call that does not name its mode", async () => {
      // The day `locality` becomes optional again, this directive is unused and
      // `pnpm typecheck` fails — which is the whole assertion. A default of
      // "none" is exactly the silent inheritance L0·1 removed.
      // @ts-expect-error — no mode: the caller must decide strict / soft / none.
      const result = await normalizeLocationForWrite(makeLocationValue(), {});
      expect(result.localityCanonical).toBe(false);
    });
  });

  describe("CoordError class", () => {
    it("is instanceof Error", () => {
      const err = new CoordError("COORD_REQUIRED", "test");
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe("COORD_REQUIRED");
    });
  });
});
