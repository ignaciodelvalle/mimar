// Unit tests for lib/geocoding.ts — the pure logic behind the
// geocodeAddressAction / reverseGeocodeAction server actions.
//
// We mock global fetch so no real Nominatim requests fire in CI.

import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import {
  __resetRateLimitForTests,
  geocodeAddress,
  intersectionQueryCandidates,
  reverseGeocode,
} from "@/lib/infra/geocoding";

beforeEach(() => {
  fetchMock.mockReset();
  __resetRateLimitForTests();
});

describe("geocodeAddress — forward", () => {
  it("returns [] for queries under 3 chars without hitting the network", async () => {
    expect(await geocodeAddress("")).toEqual([]);
    expect(await geocodeAddress("ab")).toEqual([]);
    expect(await geocodeAddress("  a  ")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("parses Nominatim payload into GeocodeResult[]", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          lat: "-34.583",
          lon: "-58.421",
          display_name: "Plaza Italia, Palermo, CABA",
          address: { state: "Buenos Aires", city: "Palermo" },
        },
      ],
    });
    const r = await geocodeAddress("Plaza Italia");
    expect(r).toHaveLength(1);
    expect(r[0].lat).toBeCloseTo(-34.583);
    expect(r[0].lng).toBeCloseTo(-58.421);
    expect(r[0].display_name).toBe("Plaza Italia, Palermo, CABA");
    expect(r[0].province).toBe("Buenos Aires");
    expect(r[0].locality).toBe("Palermo");
  });

  it("for CABA points, prefers the barrio (suburb) over the city-level 'Buenos Aires'", async () => {
    // OSM returns the city-level name in `address.city` for any CABA point; the
    // barrio is in `suburb`. The INDEC catalog has no "Buenos Aires" locality
    // under CABA (only the 48 barrios), so we must pick the barrio — otherwise
    // strict canonical validation throws "localidad Buenos Aires no existe".
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          lat: "-34.588",
          lon: "-58.430",
          display_name: "Av. Santa Fe, Palermo, CABA",
          address: {
            state: "Ciudad Autónoma de Buenos Aires",
            city: "Buenos Aires",
            suburb: "Palermo",
          },
        },
      ],
    });
    const r = await geocodeAddress("Santa Fe");
    expect(r[0].locality).toBe("Palermo");
  });

  it("non-CABA keeps city precedence (suburb does not override city)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          lat: "-31.42",
          lon: "-64.18",
          display_name: "Centro, Córdoba",
          address: { state: "Córdoba", city: "Córdoba", suburb: "Centro" },
        },
      ],
    });
    const r = await geocodeAddress("Centro");
    expect(r[0].locality).toBe("Córdoba");
  });

  it("falls through address fields city → town → suburb → village → hamlet", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          lat: "-34",
          lon: "-58",
          display_name: "Somewhere rural",
          address: { state: "X", village: "VillageName" },
        },
      ],
    });
    const r = await geocodeAddress("rural");
    expect(r[0].locality).toBe("VillageName");
  });

  it("yields locality=null when no city/town/suburb/village/hamlet is present", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { lat: "0", lon: "0", display_name: "Open ocean", address: { state: "Atlantic" } },
      ],
    });
    const r = await geocodeAddress("ocean");
    expect(r[0].province).toBe("Atlantic");
    expect(r[0].locality).toBeNull();
  });

  it("drops results with non-finite coordinates", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { lat: "nope", lon: "nope", display_name: "Garbage", address: {} },
        { lat: "-34", lon: "-58", display_name: "Good one", address: {} },
      ],
    });
    const r = await geocodeAddress("query");
    expect(r).toHaveLength(1);
    expect(r[0].display_name).toBe("Good one");
  });

  it("throws provider_error on non-2xx response", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(geocodeAddress("test")).rejects.toThrow("provider_error");
  });

  it("throws fetch_failed on network error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(geocodeAddress("test")).rejects.toThrow("fetch_failed");
  });

  it("sends the raw user query without appending bias (avoids Nominatim mis-parse)", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [] });
    await geocodeAddress("Plaza", { locality: "Belgrano", province: "Buenos Aires" });
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    const url = new URL(calledUrl);
    expect(url.searchParams.get("q")).toBe("Plaza");
    expect(url.searchParams.get("countrycodes")).toBe("ar");
    expect(url.searchParams.get("accept-language")).toBe("es");
  });

  it("sends viewbox+bounded=0 when bias.province has a known bounding box", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [] });
    await geocodeAddress("Plaza Italia", {
      province: "CABA",
      locality: "CABA",
    });
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("viewbox")).toMatch(/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/);
    expect(url.searchParams.get("bounded")).toBe("0");
  });

  it("omits viewbox when bias.province is unknown or missing", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [] });
    await geocodeAddress("Plaza Italia", { province: "Tierra del Fuego (no bbox yet)" });
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.has("viewbox")).toBe(false);
    expect(url.searchParams.has("bounded")).toBe(false);
  });

  it("sends User-Agent header per Nominatim policy", async () => {
    // La política de OSM pide un identificador de aplicación y un contacto
    // GENUINAMENTE MONITOREADO. Esta aserción pedía además que empezara con
    // "DIM/", cosa que la política no pide y que ataba el header al nombre en
    // clave interno: cuando el 2026-08-18 se descubrió que `dim.ar` no existe y
    // el header pasó a llevar la marca pública, este test falló por la razón
    // equivocada — el problema no era el prefijo, era el dominio muerto que
    // anunciaba. Ahora afirma la FORMA que la política sí exige.
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [] });
    await geocodeAddress("test");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const ua = (init.headers as Record<string, string>)["User-Agent"] as string;

    // producto/versión + un contacto entre paréntesis
    expect(ua).toMatch(/^\S+\/\d[\w.]*\s+\(.+\)$/);
    // y que ese contacto sea alcanzable de verdad, no una etiqueta
    expect(ua).toMatch(/@/);
    // nunca más un dominio inexistente: si OSM necesita avisarnos de un abuso,
    // no puede terminar en un enlace muerto
    expect(ua).not.toMatch(/dim\.ar/i);
  });
});

// ---------------------------------------------------------------------------
// Corner ("esquina") normalization — tester fix #4: "Gorriti y Serrano" failed
// while the placeholder promised corners.
// ---------------------------------------------------------------------------

describe("intersectionQueryCandidates", () => {
  it("normalizes 'X y Z' into '&' intersection queries in both orders", () => {
    expect(intersectionQueryCandidates("Gorriti y Serrano")).toEqual([
      "Gorriti & Serrano",
      "Serrano & Gorriti",
    ]);
  });

  it("handles the 'e' conjunction (before i/hi words)", () => {
    expect(intersectionQueryCandidates("Callao e Hipólito Yrigoyen")).toEqual([
      "Callao & Hipólito Yrigoyen",
      "Hipólito Yrigoyen & Callao",
    ]);
  });

  it("preserves a ', locality' suffix on every candidate", () => {
    expect(intersectionQueryCandidates("Gorriti y Serrano, Palermo")).toEqual([
      "Gorriti & Serrano, Palermo",
      "Serrano & Gorriti, Palermo",
    ]);
  });

  it("leaves 'X entre Y y Z' (between-streets) references alone", () => {
    expect(intersectionQueryCandidates("Serrano entre Gorriti y Honduras")).toEqual([]);
  });

  it("returns [] for non-corner queries", () => {
    expect(intersectionQueryCandidates("Av. Santa Fe 3253")).toEqual([]);
    expect(intersectionQueryCandidates("Plaza Italia")).toEqual([]);
    expect(intersectionQueryCandidates("")).toEqual([]);
  });

  it("rejects degenerate one-letter sides ('a y b' noise)", () => {
    expect(intersectionQueryCandidates("a y b")).toEqual([]);
  });

  it("keeps numbered streets — La Plata style '7 y 50'", () => {
    expect(intersectionQueryCandidates("Calle 7 y Calle 50")).toEqual([
      "Calle 7 & Calle 50",
      "Calle 50 & Calle 7",
    ]);
  });
});

describe("geocodeAddress — corner fallback wiring", () => {
  it("retries a failed 'X y Z' query with the '&' syntax and returns its results", async () => {
    // 1st call (raw query) → empty; 2nd call (A & B) → hit.
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [] });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          lat: "-34.588",
          lon: "-58.435",
          display_name: "Gorriti & Serrano, Palermo, CABA",
          address: { state: "Ciudad Autónoma de Buenos Aires", suburb: "Palermo" },
        },
      ],
    });

    const r = await geocodeAddress("Gorriti y Serrano");
    expect(r).toHaveLength(1);
    expect(r[0].display_name).toBe("Gorriti & Serrano, Palermo, CABA");

    const q1 = new URL(fetchMock.mock.calls[0][0] as string).searchParams.get("q");
    const q2 = new URL(fetchMock.mock.calls[1][0] as string).searchParams.get("q");
    expect(q1).toBe("Gorriti y Serrano");
    expect(q2).toBe("Gorriti & Serrano");
  });

  it("tries the reversed ordering when the first '&' attempt is also empty", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [] }); // raw
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [] }); // A & B
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { lat: "-34.6", lon: "-58.4", display_name: "Serrano & Gorriti", address: {} },
      ],
    });

    const r = await geocodeAddress("Gorriti y Serrano");
    expect(r).toHaveLength(1);
    const q3 = new URL(fetchMock.mock.calls[2][0] as string).searchParams.get("q");
    expect(q3).toBe("Serrano & Gorriti");
  });

  it("returns the original empty answer when all candidates miss", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] });
    const r = await geocodeAddress("Gorriti y Serrano");
    expect(r).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("degrades to the empty answer (no throw) when a fallback attempt errors", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [] }); // raw ok, empty
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 }); // fallback dies
    const r = await geocodeAddress("Gorriti y Serrano");
    expect(r).toEqual([]);
    // The reversed ordering is NOT attempted after an error — best-effort only.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never fires fallback requests for non-corner queries", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [] });
    await geocodeAddress("Plaza Italia");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("reverseGeocode — reverse", () => {
  it("returns null for invalid coordinates without hitting the network", async () => {
    expect(await reverseGeocode(Number.NaN, 0)).toBeNull();
    expect(await reverseGeocode(91, 0)).toBeNull();
    expect(await reverseGeocode(-91, 0)).toBeNull();
    expect(await reverseGeocode(0, 181)).toBeNull();
    expect(await reverseGeocode(0, -181)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns parsed display_name on success", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        display_name: "Plaza Italia, Palermo, CABA",
        address: { state: "Buenos Aires", city: "Palermo" },
      }),
    });
    const r = await reverseGeocode(-34.583, -58.421);
    expect(r?.display_name).toBe("Plaza Italia, Palermo, CABA");
    expect(r?.province).toBe("Buenos Aires");
    expect(r?.locality).toBe("Palermo");
  });

  it("returns null on 404 (out of OSM coverage)", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
    expect(await reverseGeocode(0, 0)).toBeNull();
  });

  it("returns null on other non-2xx (graceful degradation)", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    expect(await reverseGeocode(-34.6, -58.4)).toBeNull();
  });

  it("returns null when display_name is missing from the response", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    expect(await reverseGeocode(-34.6, -58.4)).toBeNull();
  });

  it("returns null on network failure (graceful degradation)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    expect(await reverseGeocode(-34.6, -58.4)).toBeNull();
  });
});

describe("rate limiter", () => {
  it("allows the initial bucket of 5 forward requests", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] });
    for (let i = 0; i < 5; i++) {
      await expect(geocodeAddress(`query ${i}`)).resolves.toBeDefined();
    }
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("throws rate_limited once the bucket is drained", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] });
    for (let i = 0; i < 5; i++) await geocodeAddress(`warm ${i}`);
    await expect(geocodeAddress("blocked")).rejects.toThrow("rate_limited");
  });

  it("falls back to null when reverse is rate-limited (does not throw)", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ display_name: "x" }) });
    for (let i = 0; i < 5; i++) await reverseGeocode(-34 - i * 0.01, -58);
    expect(await reverseGeocode(-34.99, -58)).toBeNull();
  });
});
