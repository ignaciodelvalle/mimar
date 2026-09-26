// `searchLocalities` asks for alias rows only when told to. The server makes
// them opt-in (`aliases=1`) because an alias row repeats its target's indecId,
// and builds that key rows by it predate aliases — so the URL this wrapper
// builds IS the compatibility contract.

import { describe, expect, it, jest } from "@jest/globals";

jest.mock("@sentry/react-native", () => ({
  captureException: () => undefined,
  addBreadcrumb: () => undefined,
}));

import { searchLocalities } from "./endpoints";

async function requestedUrl(query: Parameters<typeof searchLocalities>[0]): Promise<string> {
  const original = globalThis.fetch;
  let url = "";
  globalThis.fetch = (async (input: unknown) => {
    url = String(input);
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      json: async () => ({ payloadVersion: 1, issuedAt: "", staleAfter: "", results: [] }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  try {
    await searchLocalities(query);
  } finally {
    globalThis.fetch = original;
  }
  return url;
}

describe("searchLocalities — alias opt-in", () => {
  it("sends aliases=1 when the caller renders alias rows", async () => {
    const url = new URL(await requestedUrl({ q: "Banf", province: "AR-B", aliases: true }));
    expect(url.pathname).toBe("/api/v1/localities");
    expect(url.searchParams.get("aliases")).toBe("1");
    expect(url.searchParams.get("q")).toBe("Banf");
    expect(url.searchParams.get("province")).toBe("AR-B");
  });

  it("leaves the parameter off otherwise, so the answer is the pre-alias payload", async () => {
    const url = new URL(await requestedUrl({ q: "Banf", province: "AR-B" }));
    expect(url.searchParams.has("aliases")).toBe(false);
  });
});
