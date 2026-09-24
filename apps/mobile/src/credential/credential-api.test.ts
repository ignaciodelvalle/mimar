// The fetch layer's branching, which a reader found two defects in before this
// file existed.
//
// Both were the same shape and neither was a crash: an error the union carried
// but no message covered, rendering as a BLANK line under "No se pudo leer";
// and a malformed body diagnosed as "revisá tu conexión" to someone whose
// connection was fine. Neither would have failed a type check — the first was
// an unvalidated cast, the second a shared `try`. So the branching gets its own
// tests, and the assertion that matters most is not "the right outcome" but
// "every failure arm produces a sentence".

import { describe, expect, it } from "@jest/globals";

import { PUBLIC_CREDENTIAL_PAYLOAD_VERSION } from "@dim/contract/api";

import { type CredentialFetchResult, fetchCredential, fetchFailureMessage } from "./credential-api";

type FetchStub = {
  status: number;
  body?: unknown;
  bodyThrows?: boolean;
  fetchThrows?: unknown;
  retryAfter?: string;
};

/** Installs a one-shot `fetch` stub and restores the real one afterwards. */
async function withFetch(stub: FetchStub, token = "DIM-PAMP-0001") {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    if (stub.fetchThrows !== undefined) throw stub.fetchThrows;
    return {
      status: stub.status,
      ok: stub.status >= 200 && stub.status < 300,
      // The real `Response` always has these. The stub grew them when the
      // transport moved into `api/client.ts`, which reads `retry-after` so a 429
      // can say HOW LONG rather than "esperá un momento".
      headers: {
        get: (name: string) => (name === "retry-after" ? (stub.retryAfter ?? null) : null),
      },
      json: async () => {
        if (stub.bodyThrows) throw new SyntaxError("Unexpected token < in JSON at position 0");
        return stub.body;
      },
    } as unknown as Response;
  }) as typeof fetch;
  try {
    return await fetchCredential(token);
  } finally {
    globalThis.fetch = original;
  }
}

const okPayload = (overrides: Record<string, unknown> = {}) => ({
  payloadVersion: PUBLIC_CREDENTIAL_PAYLOAD_VERSION,
  issuedAt: "2026-08-25T12:00:00.000Z",
  staleAfter: "2026-08-25T12:05:00.000Z",
  publicToken: "DIM-PAMP-0001",
  identity: { status: "unavailable" },
  status: { status: "unavailable" },
  vaccination: { status: "unavailable" },
  notices: { status: "unavailable" },
  lost: { status: "unavailable" },
  tier2: { status: "unavailable" },
  ...overrides,
});

describe("fetchCredential — status branching", () => {
  it("returns ok on 200 with a matching payloadVersion", async () => {
    const result = await withFetch({ status: 200, body: okPayload() });
    expect(result.outcome).toBe("ok");
  });

  it("maps 404 to not_found and 429 to rate_limited from the body's code", async () => {
    expect(await withFetch({ status: 404, body: { error: "not_found" } })).toEqual({
      outcome: "api-error",
      code: "not_found",
      retryAfterSeconds: null,
    });
    expect(await withFetch({ status: 429, body: { error: "rate_limited" } })).toEqual({
      outcome: "api-error",
      code: "rate_limited",
      retryAfterSeconds: null,
    });
  });

  it("carries the server's retry-after so a 429 can say how long", () => {
    // The generic "esperá un momento" is honest and useless; a number is what
    // stops somebody tapping the button eight more times and spending the
    // budget of the finder standing over a lost animal in the street.
    return withFetch({
      status: 429,
      body: { error: "rate_limited" },
      retryAfter: "45",
    }).then((result) => {
      expect(result).toEqual({
        outcome: "api-error",
        code: "rate_limited",
        retryAfterSeconds: 45,
      });
      expect(fetchFailureMessage(result)).toContain("45 segundos");
    });
  });

  it("keeps the degraded 503 body instead of collapsing it into an error", async () => {
    // The degraded envelope still carries the animal's name and the lost CTAs.
    // Folding it into a bare error throws away the only thing a finder could use.
    const degraded = {
      error: "temporarily_unavailable",
      payloadVersion: PUBLIC_CREDENTIAL_PAYLOAD_VERSION,
      issuedAt: "2026-08-25T12:00:00.000Z",
      staleAfter: "2026-08-25T12:05:00.000Z",
      publicToken: "DIM-PAMP-0001",
      identity: {
        status: "ok",
        data: { name: "Pampa", sex: "female", isLost: true, allowFinderForm: true },
      },
    };
    const result = await withFetch({ status: 503, body: degraded });
    expect(result.outcome).toBe("degraded");
    if (result.outcome === "degraded") {
      expect(result.payload.identity).toEqual(degraded.identity);
    }
  });

  it("never answers not_found to a read failure", async () => {
    // The contract calls that "the worst lie a public surface can tell".
    const result = await withFetch({ status: 500, body: { error: "temporarily_unavailable" } });
    expect(result).toEqual({
      outcome: "api-error",
      code: "temporarily_unavailable",
      retryAfterSeconds: null,
    });
  });
});

describe("fetchCredential — codes outside the contract's vocabulary", () => {
  it("does NOT pass an unknown error code through as if it were valid", async () => {
    // Regression: a `typeof === "string"` check let any string become an
    // ApiV1ErrorCode, which then matched no case in the message switch and
    // rendered as a blank line on the screen.
    const result = await withFetch({ status: 400, body: { error: "teapot" } });
    expect(result).toEqual({
      outcome: "api-error",
      code: "temporarily_unavailable",
      retryAfterSeconds: null,
    });
  });

  it("survives an error body that is not an object at all", async () => {
    expect(await withFetch({ status: 500, body: "boom" })).toEqual({
      outcome: "api-error",
      code: "temporarily_unavailable",
      retryAfterSeconds: null,
    });
    expect(await withFetch({ status: 500, body: null })).toEqual({
      outcome: "api-error",
      code: "temporarily_unavailable",
      retryAfterSeconds: null,
    });
  });
});

describe("fetchCredential — the payloadVersion gate", () => {
  it("refuses a payload from a future contract instead of guessing at it", async () => {
    const result = await withFetch({ status: 200, body: okPayload({ payloadVersion: 99 }) });
    expect(result).toEqual({ outcome: "unsupported-version", received: 99 });
  });

  it("reports null — not NaN — when the version is missing or not a number", async () => {
    expect(
      await withFetch({ status: 200, body: okPayload({ payloadVersion: undefined }) }),
    ).toEqual({ outcome: "unsupported-version", received: null });
    expect(await withFetch({ status: 200, body: okPayload({ payloadVersion: "1" }) })).toEqual({
      outcome: "unsupported-version",
      received: null,
    });
  });
});

describe("fetchCredential — transport vs body", () => {
  it("calls a dead connection unreachable", async () => {
    const result = await withFetch({
      status: 0,
      fetchThrows: new TypeError("Network request failed"),
    });
    expect(result.outcome).toBe("unreachable");
  });

  it("does NOT blame the connection for a body it could not parse", async () => {
    // Regression: both were in one `try`, so a truncated body told a user with
    // a working connection to go check their connection.
    const result = await withFetch({ status: 200, bodyThrows: true });
    expect(result.outcome).toBe("malformed");
    expect(fetchFailureMessage(result)).not.toContain("conexión");
  });
});

describe("fetchFailureMessage", () => {
  it("gives EVERY failure arm a sentence, and only the success arms none", () => {
    // The blank-line bug in one assertion: if any failure outcome ever maps to
    // null, the screen renders an empty <Text> under "No se pudo leer".
    const failures: CredentialFetchResult[] = [
      { outcome: "api-error", code: "rate_limited", retryAfterSeconds: null },
      { outcome: "api-error", code: "not_found", retryAfterSeconds: null },
      { outcome: "api-error", code: "temporarily_unavailable", retryAfterSeconds: null },
      { outcome: "unsupported-version", received: 99 },
      { outcome: "unsupported-version", received: null },
      { outcome: "malformed", detail: "bad json" },
      { outcome: "unreachable", detail: "offline" },
    ];

    for (const failure of failures) {
      const message = fetchFailureMessage(failure);
      expect(typeof message).toBe("string");
      expect((message ?? "").trim().length).toBeGreaterThan(0);
    }
  });

  it("says nothing for a version it could not read, rather than 'vNaN'", () => {
    const message = fetchFailureMessage({ outcome: "unsupported-version", received: null });
    expect(message).toContain("desconocida");
    expect(message).not.toContain("NaN");
  });
});
