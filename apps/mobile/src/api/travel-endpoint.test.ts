// `fetchPetTravel` / `sendPetTravelCommand` — the URL and the header ARE the
// contract with `/api/v1/pets/{token}/travel`: `?trip=` selects the trip the
// semáforo reads, and every command carries its `Idempotency-Key`, without
// which the server answers 400 `idempotency_key_required`. The export
// (`requestPetTravelExport`) is the one POST that carries neither body nor key.

import { describe, expect, it, jest } from "@jest/globals";

jest.mock("@sentry/react-native", () => ({
  captureException: () => undefined,
  addBreadcrumb: () => undefined,
}));

import { PET_TRAVEL_REFUSAL_MESSAGES } from "@dim/contract/api";

import { type SessionPort, apiFailureMessage } from "./client";
import { fetchPetTravel, requestPetTravelExport, sendPetTravelCommand } from "./endpoints";
import { apiErrorMessage, apiRefusalMessage } from "./error-copy";

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

describe("requestPetTravelExport", () => {
  it("posts for the PDF of the trip on screen, with no body and no key", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const { url, init } = await capture(
      () => requestPetTravelExport(fakeSession(), "DIM-PAMP-0001", id),
      { pdfUrl: "https://storage.example/viaje.pdf?token=x", expiresAt: "2026-10-01T00:00:00Z" },
    );
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/api/v1/pets/DIM-PAMP-0001/travel/export");
    expect(parsed.searchParams.get("trip")).toBe(id);
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeUndefined();
    // Nothing lands on the spine: the server takes no key for an export.
    expect(header(init, "idempotency-key")).toBeNull();
  });

  it("leaves the trip to the server when none is asked for", async () => {
    const { url } = await capture(
      () => requestPetTravelExport(fakeSession(), "DIM-PAMP-0001", null),
      { pdfUrl: "https://storage.example/viaje.pdf", expiresAt: "2026-10-01T00:00:00Z" },
    );
    expect(new URL(url).searchParams.has("trip")).toBe(false);
  });
});

describe("a refused trip names WHICH input was wrong (v14 `reason`)", () => {
  const TRIP = {
    command: "record_trip" as const,
    corridorId: "chile" as const,
    travelDate: "2026-10-01",
    mode: null,
    airlineId: null,
    intendedModality: null,
  };

  /** One POST answered 400 with `body`, or with a body that is not JSON. */
  async function refused(body: unknown | "not-json") {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({
        status: 400,
        ok: false,
        headers: { get: () => null },
        json: async () => {
          if (body === "not-json") throw new SyntaxError("Unexpected token <");
          return body;
        },
      }) as unknown as Response) as unknown as typeof fetch;
    try {
      return await sendPetTravelCommand(fakeSession(), "DIM-PAMP-0001", TRIP, "key");
    } finally {
      globalThis.fetch = original;
    }
  }

  /** The sentence without the correlation line a reported failure carries. */
  function sentence(result: Parameters<typeof apiFailureMessage>[0]): string | undefined {
    return apiFailureMessage(result)?.split("\n")[0];
  }

  it("a known reason gets the contract's own sentence", async () => {
    const result = await refused({
      error: "travel_input_invalid",
      reason: "TRAVEL_DATE_OUT_OF_RANGE",
    });
    expect(result).toMatchObject({
      outcome: "api-error",
      code: "travel_input_invalid",
      reason: "TRAVEL_DATE_OUT_OF_RANGE",
    });
    expect(sentence(result)).toBe(PET_TRAVEL_REFUSAL_MESSAGES.TRAVEL_DATE_OUT_OF_RANGE);
  });

  it("a reason this build does not know falls back to the code's sentence", async () => {
    const result = await refused({ error: "travel_input_invalid", reason: "SOMETHING_NEWER" });
    expect(result).toMatchObject({ outcome: "api-error", reason: "SOMETHING_NEWER" });
    expect(sentence(result)).toBe(apiErrorMessage("travel_input_invalid"));
  });

  it("no reason (an older server) keeps the code's sentence and adds no field", async () => {
    const result = await refused({ error: "travel_input_invalid" });
    expect(result.outcome).toBe("api-error");
    expect("reason" in result).toBe(false);
    expect(sentence(result)).toBe(apiErrorMessage("travel_input_invalid"));
  });

  it("a reason that is not a non-empty string is ignored", async () => {
    for (const reason of [42, "", null, { nested: true }]) {
      const result = await refused({ error: "travel_input_invalid", reason });
      expect("reason" in result).toBe(false);
    }
  });

  it("a body that is not JSON reads as the outage it is, with no reason", async () => {
    const result = await refused("not-json");
    expect(result).toMatchObject({ outcome: "api-error", code: "temporarily_unavailable" });
    expect("reason" in result).toBe(false);
    expect(sentence(result)).toBe(apiErrorMessage("temporarily_unavailable"));
  });

  it("a reason never rewords another code", () => {
    expect(apiRefusalMessage("trip_duplicate", "TRAVEL_DATE_OUT_OF_RANGE")).toBe(
      apiErrorMessage("trip_duplicate"),
    );
    expect(apiRefusalMessage("travel_input_invalid", "AIRLINE_UNKNOWN")).toBe(
      PET_TRAVEL_REFUSAL_MESSAGES.AIRLINE_UNKNOWN,
    );
  });
});
