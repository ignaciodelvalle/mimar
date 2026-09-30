// `fetchPetTravel` / `sendPetTravelCommand` — the URL and the header ARE the
// contract with `/api/v1/pets/{token}/travel`: `?trip=` selects the trip the
// semáforo reads, and every command carries its `Idempotency-Key`, without
// which the server answers 400 `idempotency_key_required`.

import { describe, expect, it, jest } from "@jest/globals";

jest.mock("@sentry/react-native", () => ({
  captureException: () => undefined,
  addBreadcrumb: () => undefined,
}));

import type { SessionPort } from "./client";
import { fetchPetTravel, sendPetTravelCommand } from "./endpoints";

type Captured = { url: string; init: RequestInit | undefined };

function fakeSession(): SessionPort {
  return {
    accessToken: async () => "token",
    refreshAccessToken: async () => ({ ok: false, reason: "refused" }) as const,
    endSession: async () => undefined,
  };
}

async function capture(run: () => Promise<unknown>, body: unknown): Promise<Captured> {
  const original = globalThis.fetch;
  const captured: Captured = { url: "", init: undefined };
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    captured.url = String(input);
    captured.init = init;
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
  return captured;
}

function header(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers;
  if (headers === undefined) return null;
  if (headers instanceof Headers) return headers.get(name);
  const record = headers as Record<string, string>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === name);
  return key === undefined ? null : (record[key] ?? null);
}

const READ = { payloadVersion: 1, issuedAt: "", staleAfter: "" };

describe("fetchPetTravel", () => {
  it("leaves the trip to the server when none is asked for", async () => {
    const { url } = await capture(() => fetchPetTravel(fakeSession(), "DIM-PAMP-0001", null), READ);
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/api/v1/pets/DIM-PAMP-0001/travel");
    expect(parsed.searchParams.has("trip")).toBe(false);
  });

  it("asks for one trip by its event id", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const { url } = await capture(() => fetchPetTravel(fakeSession(), "DIM-PAMP-0001", id), READ);
    expect(new URL(url).searchParams.get("trip")).toBe(id);
  });

  it("refuses a payload version it does not know", async () => {
    let outcome = "";
    await capture(
      async () => {
        const result = await fetchPetTravel(fakeSession(), "DIM-PAMP-0001", null);
        outcome = result.outcome;
      },
      { ...READ, payloadVersion: 99 },
    );
    expect(outcome).toBe("unsupported-version");
  });
});

describe("sendPetTravelCommand", () => {
  it("posts the command with its Idempotency-Key", async () => {
    const key = "aaaaaaaa-1111-4222-8333-444444444444";
    const { url, init } = await capture(
      () =>
        sendPetTravelCommand(
          fakeSession(),
          "DIM-PAMP-0001",
          { command: "cancel_trip", tripEventId: "11111111-1111-4111-8111-111111111111" },
          key,
        ),
      {
        command: "cancel_trip",
        tripEventId: "11111111-1111-4111-8111-111111111111",
        changed: true,
      },
    );
    expect(new URL(url).pathname).toBe("/api/v1/pets/DIM-PAMP-0001/travel");
    expect(init?.method).toBe("POST");
    expect(header(init, "idempotency-key")).toBe(key);
    expect(JSON.parse(String(init?.body))).toMatchObject({ command: "cancel_trip" });
  });
});
