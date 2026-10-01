// `fetchAppointmentSearch` builds the query string the server reads, so the URL
// IS the contract — the reason `localities-endpoint.test.ts` exists, applied to
// the turnos search.
//
// F-3 added the one param the web does not publish yet, `ampliar=ciudad`, and
// nothing else would notice a typo in it: the screen test mocks this module, and
// the route test parses a URL it wrote itself. A misspelt param is not an error
// anywhere — the server reads "not asked" and the CABA fallback silently never
// happens.

import { describe, expect, it, jest } from "@jest/globals";

jest.mock("@sentry/react-native", () => ({
  captureException: () => undefined,
  addBreadcrumb: () => undefined,
}));

import type { SessionPort } from "./client";
import { fetchAppointmentSearch } from "./endpoints";

const session: SessionPort = {
  accessToken: async () => "token",
  refreshAccessToken: async () => ({ ok: false, reason: "refused" }),
  endSession: async () => undefined,
};

async function requestedUrl(query: Parameters<typeof fetchAppointmentSearch>[1]): Promise<URL> {
  const original = globalThis.fetch;
  let url = "";
  globalThis.fetch = (async (input: unknown) => {
    url = String(input);
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      json: async () => ({ payloadVersion: 1 }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  try {
    await fetchAppointmentSearch(session, query);
  } finally {
    globalThis.fetch = original;
  }
  return new URL(url);
}

describe("fetchAppointmentSearch — the query string", () => {
  it("asks for the city fallback as `ampliar=ciudad`, the literal the route reads", async () => {
    const url = await requestedUrl({ serviceKind: "vaccination_rabies", widenToCity: true });
    expect(url.pathname).toBe("/api/v1/appointments");
    expect(url.searchParams.get("ampliar")).toBe("ciudad");
  });

  it("sends no `ampliar` at all when it was not asked for", async () => {
    // An omitted filter is not an empty one — the wrapper's own rule.
    const url = await requestedUrl({ serviceKind: "vaccination_rabies" });
    expect(url.searchParams.has("ampliar")).toBe(false);
  });

  it("keeps the web's names for every other filter", async () => {
    const url = await requestedUrl({
      serviceKind: "vaccination_rabies",
      province: "CABA",
      locality: "Palermo",
      fechaDesde: "2026-10-05",
      freeOnly: true,
      widenToCity: true,
    });
    expect(Object.fromEntries(url.searchParams)).toEqual({
      service_kind: "vaccination_rabies",
      province: "CABA",
      locality: "Palermo",
      fecha_desde: "2026-10-05",
      solo_gratis: "true",
      ampliar: "ciudad",
    });
  });
});
