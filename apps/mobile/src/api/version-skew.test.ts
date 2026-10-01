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

import { fetchCredential } from "../credential/credential-api";
import { type ApiResult, type SessionPort, apiFailureMessage, apiRequest } from "./client";
import { login, requestPasswordReset, searchLocalities, signup } from "./endpoints";

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

// ---------------------------------------------------------------------------
// F-6 (native review 2026-09-23) — THE DOORS WITH NO BEARER
//
// `login`, `signup`, `requestPasswordReset`, `searchLocalities` and the public
// credential read build their result from `performRequest` themselves, because
// `apiRequest` would ask the session port for a token that does not exist yet.
// Until F-6 that shortcut skipped the report too: ingreso, crear cuenta,
// recuperar and the credential printed every sentence `apiFailureMessage` has
// EXCEPT the "Código" — on the screens "no me dejó entrar" is said about.
// ---------------------------------------------------------------------------

/** A one-shot answer, with the two shapes the bearer stub above cannot make. */
function stubAnswer(answer: {
  status: number;
  body?: unknown;
  bodyThrows?: boolean;
  retryAfter?: string;
}) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      status: answer.status,
      ok: answer.status >= 200 && answer.status < 300,
      headers: {
        get: (name: string) => (name === "retry-after" ? (answer.retryAfter ?? null) : null),
      },
      json: async () => {
        if (answer.bodyThrows) throw new SyntaxError("Unexpected end of JSON input");
        return answer.body;
      },
    }) as unknown as Response) as unknown as typeof fetch;
  return {
    restore() {
      globalThis.fetch = original;
    },
  };
}

const callLogin = () => login({ email: "ana@dim.test", password: "unaClaveLarga" });
const callSignup = () =>
  signup({
    email: "ana@dim.test",
    password: "unaClaveLarga",
    confirmPassword: "unaClaveLarga",
    tosAccepted: true,
  });

/** Every no-bearer door, each with the route TEMPLATE its report must carry. */
const NO_BEARER_DOORS: ReadonlyArray<{
  door: string;
  route: string;
  call: () => Promise<ApiResult<unknown>>;
}> = [
  { door: "login", route: "/api/v1/auth/login", call: callLogin },
  { door: "signup", route: "/api/v1/auth/signup", call: callSignup },
  {
    door: "requestPasswordReset",
    route: "/api/v1/auth/password-reset",
    call: () => requestPasswordReset({ email: "ana@dim.test" }),
  },
  {
    door: "searchLocalities",
    route: "/api/v1/localities",
    call: () => searchLocalities({ q: "Palermo", province: "AR-C" }),
  },
  {
    door: "fetchCredential",
    route: "/api/v1/pets/:id/credential",
    call: async () => {
      const result = await fetchCredential("DIM-PAMP-0001");
      if (result.outcome === "degraded") throw new Error("a malformed body is not degraded");
      return result;
    },
  },
];

async function knock(
  call: () => Promise<ApiResult<unknown>>,
  answer: Parameters<typeof stubAnswer>[0],
): Promise<ApiResult<unknown>> {
  captured.length = 0;
  const stub = stubAnswer(answer);
  try {
    return await call();
  } finally {
    stub.restore();
  }
}

describe("the doors with no bearer report like every other call (F-6)", () => {
  it.each(NO_BEARER_DOORS)(
    "$door files a malformed answer and prints the id it filed it under",
    async ({ call, route }) => {
      const result = await knock(call, { status: 200, bodyThrows: true });

      expect(result.outcome).toBe("malformed");
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({ surface: "api", failure: "malformed", route });
      // THE SAME ID ON BOTH SIDES, read from the Sentry stub rather than from the
      // result — a code on screen that matches no event is worse than none.
      const filed = captured[0]?.correlation_id;
      expect(filed).toMatch(/^[0-9a-f]{8}$/);
      expect(apiFailureMessage(result)).toContain(`Código: ${filed}`);
    },
  );

  it.each(NO_BEARER_DOORS)(
    "$door files a skew refusal (invalid_request) as an api-error with its code",
    async ({ call }) => {
      const result = await knock(call, { status: 400, body: { error: "invalid_request" } });

      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({
        failure: "api-error",
        api_error_code: "invalid_request",
      });
      expect(apiFailureMessage(result)).toContain(`Código: ${captured[0]?.correlation_id}`);
    },
  );

  it("never puts the pet's token or the typed query in a tag", async () => {
    // The two filled paths among these doors: the credential carries the token,
    // the typeahead carries whatever the person was typing in `q`.
    for (const { call } of NO_BEARER_DOORS) {
      await knock(call, { status: 200, bodyThrows: true });
      const tags = JSON.stringify(captured);
      expect(tags).not.toContain("DIM-PAMP-0001");
      expect(tags).not.toContain("Palermo");
    }
  });

  it("leaves an ordinary refusal unreported and still counts a 429 down", async () => {
    // The short list holds here too: a wrong password is somebody's situation,
    // and the three signups a minute an IP is allowed are reached by people.
    const refused = await knock(callLogin, { status: 401, body: { error: "invalid_credentials" } });
    expect(captured).toHaveLength(0);
    expect(apiFailureMessage(refused)).not.toContain("Código");

    const limited = await knock(callSignup, {
      status: 429,
      body: { error: "rate_limited" },
      retryAfter: "30",
    });
    expect(captured).toHaveLength(0);
    expect(apiFailureMessage(limited)).toBe("Demasiadas consultas. Probá de nuevo en 30 segundos.");
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
