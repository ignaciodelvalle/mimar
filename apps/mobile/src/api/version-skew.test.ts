// Two questions this app could not answer before 2026-09-07, both of them
// about the day the server and a published bundle stop agreeing.
//
// 1. OBS-2 — WHICH handled failures reach us at all. `apiRequest` answering
//    `malformed` is not a crash and produced no event, so a contract break on
//    one endpoint looked exactly like a good week across fourteen phones.
//
// 2. CANON-451 (critic gap 3) — an OTA channel makes version skew ORDINARY in
//    both directions: a bundle outlives the server it was written against, and
//    a server ships a refusal code a published bundle will never know. The
//    client used to call that `temporarily_unavailable` and tell the person to
//    wait a few seconds for a code that will still be unknown tomorrow.

import { describe, expect, it, jest } from "@jest/globals";

type CapturedTags = Record<string, string>;
const captured: CapturedTags[] = [];

jest.mock("@sentry/react-native", () => ({
  captureException: (_error: unknown, context: { tags: CapturedTags }) => {
    captured.push(context.tags);
  },
  addBreadcrumb: () => undefined,
}));

import {
  UNKNOWN_API_ERROR_MESSAGE,
  apiErrorMessageForWireCode,
  carriesUnknownErrorCode,
} from "./error-copy";

import { type SessionPort, apiFailureMessage, apiRequest } from "./client";

function stubFetch(answer: { status: number; body: unknown }) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      status: answer.status,
      ok: answer.status >= 200 && answer.status < 300,
      headers: { get: () => null },
      json: async () => answer.body,
    }) as unknown as Response) as unknown as typeof fetch;
  return {
    restore() {
      globalThis.fetch = original;
    },
  };
}

function fakeSession(): SessionPort {
  return {
    accessToken: async () => "token",
    refreshAccessToken: async () => ({ ok: false, reason: "refused" }) as const,
    endSession: async () => undefined,
  };
}

async function request(answer: { status: number; body: unknown }, path = "/api/v1/me") {
  captured.length = 0;
  const stub = stubFetch(answer);
  try {
    return await apiRequest({ path }, fakeSession());
  } finally {
    stub.restore();
  }
}

describe("what reaches Sentry, and what deliberately does not", () => {
  it("reports a malformed payload and hands the screen the id it filed it under", async () => {
    const stub = stubFetch({ status: 200, body: undefined });
    captured.length = 0;
    // A 2xx whose body does not parse: `json()` rejecting is the real shape.
    globalThis.fetch = (async () =>
      ({
        status: 200,
        ok: true,
        headers: { get: () => null },
        json: async () => {
          throw new Error("Unexpected end of JSON input");
        },
      }) as unknown as Response) as unknown as typeof fetch;
    const result = await apiRequest({ path: "/api/v1/me" }, fakeSession());
    stub.restore();

    expect(result.outcome).toBe("malformed");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      surface: "api",
      failure: "malformed",
      route: "/api/v1/me",
    });
    expect(result.outcome === "malformed" && result.correlationId).toBe(
      captured[0]?.correlation_id,
    );
  });

  it("reports the route TEMPLATE, never the pet's token", async () => {
    // The tag is indexed forever. See `telemetryPath` in observability/report.
    await request({ status: 200, body: undefined }, "/api/v1/pets/DIM-PAMP-0001/document").catch(
      () => undefined,
    );
    const stub = stubFetch({ status: 400, body: { error: "invalid_request" } });
    captured.length = 0;
    await apiRequest({ path: "/api/v1/pets/DIM-PAMP-0001/document" }, fakeSession());
    stub.restore();

    expect(captured[0]?.route).toBe("/api/v1/pets/:id/document");
    expect(JSON.stringify(captured[0])).not.toContain("DIM-PAMP-0001");
  });

  it("reports the two codes that mean this build and this server disagree", async () => {
    const result = await request({ status: 400, body: { error: "invalid_request" } });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ failure: "api-error", api_error_code: "invalid_request" });
    expect(result.outcome === "api-error" && typeof result.correlationId).toBe("string");
  });

  it("does NOT report an ordinary refusal — a 404 is somebody's situation", async () => {
    // The point of the short list. Reporting `not_found`, `transfer_expired` or
    // `rate_limited` would file thousands of events that say nothing and bury
    // the one malformed payload that mattered.
    const result = await request({ status: 404, body: { error: "not_found" } });
    expect(captured).toHaveLength(0);
    expect(result.outcome === "api-error" && result.correlationId).toBeUndefined();
  });

  it("does NOT report a phone with no signal", async () => {
    captured.length = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError("Network request failed");
    }) as unknown as typeof fetch;
    const result = await apiRequest({ path: "/api/v1/me" }, fakeSession());
    globalThis.fetch = original;

    expect(result.outcome).toBe("unreachable");
    expect(captured).toHaveLength(0);
  });
});

describe("a refusal code this build has never heard of (CANON-451)", () => {
  it("reads a 4xx with an unknown code as version skew, not as an outage", async () => {
    const result = await request({ status: 409, body: { error: "welfare_case_reopen_refused" } });

    expect(result).toMatchObject({ outcome: "unsupported-version", received: null });
    // The sentence a person can act on. "El servidor no pudo responder, volvé a
    // intentar en unos segundos" is an instruction to wait, and waiting will
    // never make the code known.
    expect(apiFailureMessage(result)).toContain("Actualizá la app");
  });

  it("still calls a 5xx an outage, even when its body carries a string", async () => {
    // A load balancer's `{"error":"Bad Gateway"}` is not a new contract. Telling
    // somebody to update their app during an outage is the same lie in the
    // other direction.
    const result = await request({ status: 502, body: { error: "Bad Gateway" } });

    expect(result).toMatchObject({ outcome: "api-error", code: "temporarily_unavailable" });
  });

  it("leaves a 4xx with NO code alone — an unreadable refusal is still an outage", async () => {
    const result = await request({ status: 400, body: { detail: "nope" } });
    expect(result).toMatchObject({ outcome: "api-error", code: "temporarily_unavailable" });
  });

  it("does NOT read 401, 403 or 429 as skew, whatever string they carry (P1)", async () => {
    // Those three are answered by layers that are not this app's `/api/v1`
    // vocabulary — an auth proxy, a WAF, a rate limiter, a platform edge — and
    // "Actualizá la app" is the wrong instruction for every one of them.
    // Nothing in front of the app writes such a body TODAY, which is exactly why
    // this guard is cheap and why the fence has to be the test rather than the
    // measurement.
    for (const status of [401, 403, 429]) {
      const result = await request({ status, body: { error: "waf_challenge_required" } });
      expect(result).not.toMatchObject({ outcome: "unsupported-version" });
      expect(apiFailureMessage(result)).not.toContain("Actualizá la app");
    }

    // The control: a 409 with the same unknown string is still skew, so the
    // guard narrowed the rule rather than switching it off.
    const skew = await request({ status: 409, body: { error: "waf_challenge_required" } });
    expect(skew).toMatchObject({ outcome: "unsupported-version" });
  });
});

describe("the code reaches the screen (OBS-3)", () => {
  it("prints 'Código: …' under the sentence, and only for a reported failure", async () => {
    const reported = await request({ status: 400, body: { error: "invalid_request" } });
    const filed = captured[0]?.correlation_id;
    expect(filed).toMatch(/^[0-9a-f]{8}$/);

    const message = apiFailureMessage(reported);
    // The SAME id that is on the Sentry event — a code that does not match the
    // event is worse than no code, because support will look for it.
    expect(message).toContain(`Código: ${filed}`);
    expect(message?.startsWith("La app envió un pedido")).toBe(true);

    // An ordinary refusal keeps its sentence exactly as it was: a code nobody
    // can look up is noise on a screen somebody is already annoyed at.
    const ordinary = await request({ status: 404, body: { error: "not_found" } });
    expect(apiFailureMessage(ordinary)).toBe("No encontramos una credencial para este código.");
  });
});

describe("error-copy's second door", () => {
  it("tells a declared unknown code apart from no code at all", () => {
    expect(carriesUnknownErrorCode({ error: "welfare_case_reopen_refused" })).toBe(true);
    expect(carriesUnknownErrorCode({ error: "not_found" })).toBe(false);
    expect(carriesUnknownErrorCode({ error: "" })).toBe(false);
    expect(carriesUnknownErrorCode({})).toBe(false);
    expect(carriesUnknownErrorCode(null)).toBe(false);
    expect(carriesUnknownErrorCode("not_found")).toBe(false);
  });

  it("answers a known code with its own sentence and an unknown one with the update sentence", () => {
    expect(apiErrorMessageForWireCode("not_found")).toBe(
      "No encontramos una credencial para este código.",
    );
    expect(apiErrorMessageForWireCode("welfare_case_reopen_refused")).toBe(
      UNKNOWN_API_ERROR_MESSAGE,
    );
    // NEVER the raw code. `error: "welfare_case_reopen_refused"` on screen is a
    // developer's string in a citizen's wallet.
    expect(apiErrorMessageForWireCode("welfare_case_reopen_refused")).not.toContain(
      "welfare_case_reopen_refused",
    );
  });
});
