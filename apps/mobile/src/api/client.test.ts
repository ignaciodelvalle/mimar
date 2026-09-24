// The fetch wrapper's two jobs: saying what went wrong, and deciding when a
// session is over.
//
// The second is the one worth the most tests. It is the only place in this app
// that can produce an infinite loop (refresh → retry → refuse → refresh …), the
// only place that can sign a user out for a reason that is not their fault, and
// the only place that can leave a signed-out user believing they are signed in.
// None of that is visible in a type.
//
// The first job gets ONE test that iterates the contract's own array rather than
// a list of hand-copied codes — because a hand-copied list is exactly what the
// exhaustive switch exists to make unnecessary, and a test that repeats the
// mistake it is guarding against proves nothing.

import { describe, expect, it } from "@jest/globals";

import { API_V1_ERROR_CODES, ME_PAYLOAD_VERSION } from "@dim/contract/api";

import {
  type ApiResult,
  type SessionEndReason,
  type SessionPort,
  apiFailureMessage,
  apiRequest,
} from "./client";

type StubResponse = { status: number; body: unknown; retryAfter?: string };

/** Records what was sent, replays a queue of answers. */
function stubFetch(responses: StubResponse[]) {
  const sentAuthorization: (string | null)[] = [];
  let call = 0;

  const impl = async (_url: string, init: { headers?: Record<string, string> }) => {
    const headers = init?.headers ?? {};
    sentAuthorization.push(headers.authorization ?? null);
    const answer = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return {
      status: answer?.status ?? 500,
      ok: (answer?.status ?? 500) >= 200 && (answer?.status ?? 500) < 300,
      headers: {
        get: (name: string) => (name === "retry-after" ? (answer?.retryAfter ?? null) : null),
      },
      json: async () => answer?.body,
    } as unknown as Response;
  };

  const original = globalThis.fetch;
  globalThis.fetch = impl as unknown as typeof fetch;
  return {
    sentAuthorization,
    get calls() {
      return call;
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}

type FakeSession = SessionPort & {
  ended: SessionEndReason[];
  refreshes: number;
};

function fakeSession(
  options: {
    token?: string | null;
    refreshTo?: string | null;
    /**
     * Why the refresh failed, when `refreshTo` is null. Defaults to "refused" —
     * the session-ending arm the pre-D7 port had as its only failure.
     */
    refreshFailure?: "refused" | "unreachable";
  } = {},
): FakeSession {
  const ended: SessionEndReason[] = [];
  let refreshes = 0;
  let token = options.token === undefined ? "token-1" : options.token;

  return {
    ended,
    get refreshes() {
      return refreshes;
    },
    async accessToken() {
      return token;
    },
    async refreshAccessToken() {
      refreshes += 1;
      const next = options.refreshTo === undefined ? "token-2" : options.refreshTo;
      if (next === null) return { ok: false, reason: options.refreshFailure ?? "refused" };
      token = next;
      return { ok: true, token: next };
    },
    async endSession(reason) {
      ended.push(reason);
    },
  };
}

const ME_OK = { payloadVersion: ME_PAYLOAD_VERSION, user: { profilePending: true, id: "u1" } };

describe("apiFailureMessage — every arm produces a sentence", () => {
  it("covers EVERY code in the contract's vocabulary", () => {
    // Iterating API_V1_ERROR_CODES rather than listing codes here is the whole
    // point: when the contract widens, this test widens with it. The exhaustive
    // switch makes the omission a compile error; this makes it a red test even
    // for someone who added a `default` in a hurry.
    for (const code of API_V1_ERROR_CODES) {
      const message = apiFailureMessage({ outcome: "api-error", code, retryAfterSeconds: null });
      expect(typeof message).toBe("string");
      expect((message ?? "").trim().length).toBeGreaterThan(0);
    }
  });

  it("covers every non-success outcome, and only success maps to null", () => {
    const failures: ApiResult<unknown>[] = [
      { outcome: "api-error", code: "rate_limited", retryAfterSeconds: null },
      { outcome: "unsupported-version", received: 99 },
      { outcome: "unsupported-version", received: null },
      { outcome: "malformed", detail: "bad json" },
      { outcome: "unreachable", detail: "offline" },
    ];
    for (const failure of failures) {
      expect((apiFailureMessage(failure) ?? "").trim().length).toBeGreaterThan(0);
    }
    expect(apiFailureMessage({ outcome: "ok", payload: null })).toBeNull();
  });

  it("says 'vdesconocida', never 'vNaN'", () => {
    const message = apiFailureMessage({ outcome: "unsupported-version", received: null });
    expect(message).toContain("desconocida");
    expect(message).not.toContain("NaN");
  });
});

describe("apiFailureMessage — the 429 wait", () => {
  it("names the wait when the server sent one", () => {
    expect(
      apiFailureMessage({ outcome: "api-error", code: "rate_limited", retryAfterSeconds: 30 }),
    ).toContain("30 segundos");
  });

  it("agrees in number for a one-second wait", () => {
    const message = apiFailureMessage({
      outcome: "api-error",
      code: "rate_limited",
      retryAfterSeconds: 1,
    });
    expect(message).toContain("1 segundo.");
    expect(message).not.toContain("1 segundos");
  });

  it("falls back to the generic sentence when the server sent no retry-after", () => {
    const message = apiFailureMessage({
      outcome: "api-error",
      code: "rate_limited",
      retryAfterSeconds: null,
    });
    expect(message).toContain("Esperá un momento");
  });
});

describe("apiRequest — the session policy", () => {
  it("attaches the bearer and returns the payload", async () => {
    const fetchStub = stubFetch([{ status: 200, body: ME_OK }]);
    const session = fakeSession();
    try {
      const result = await apiRequest(
        { path: "/api/v1/me", expectedPayloadVersion: ME_PAYLOAD_VERSION },
        session,
      );
      expect(result.outcome).toBe("ok");
      expect(fetchStub.sentAuthorization).toEqual(["Bearer token-1"]);
      expect(session.ended).toEqual([]);
    } finally {
      fetchStub.restore();
    }
  });

  it("refreshes ONCE on auth_expired and retries with the new token", async () => {
    const fetchStub = stubFetch([
      { status: 401, body: { error: "auth_expired" } },
      { status: 200, body: ME_OK },
    ]);
    const session = fakeSession();
    try {
      const result = await apiRequest(
        { path: "/api/v1/me", expectedPayloadVersion: ME_PAYLOAD_VERSION },
        session,
      );
      expect(result.outcome).toBe("ok");
      expect(session.refreshes).toBe(1);
      expect(fetchStub.sentAuthorization).toEqual(["Bearer token-1", "Bearer token-2"]);
      // The session survived: a refresh that worked is not a reason to sign out.
      expect(session.ended).toEqual([]);
    } finally {
      fetchStub.restore();
    }
  });

  it("signs out after ONE failed retry — not a loop", async () => {
    // THE LOOP THIS PREVENTS: refresh, retry, refused, refresh again… against
    // GoTrue, on behalf of a user who is simply signed out. One refresh, one
    // retry, then stop.
    const fetchStub = stubFetch([
      { status: 401, body: { error: "auth_expired" } },
      { status: 401, body: { error: "auth_expired" } },
    ]);
    const session = fakeSession();
    try {
      const result = await apiRequest({ path: "/api/v1/me" }, session);
      expect(result).toEqual({
        outcome: "api-error",
        code: "auth_expired",
        retryAfterSeconds: null,
      });
      expect(session.refreshes).toBe(1);
      expect(fetchStub.calls).toBe(2);
      expect(session.ended).toEqual(["auth_expired"]);
    } finally {
      fetchStub.restore();
    }
  });

  it("does not retry when the refresh is REFUSED, and ends the session", async () => {
    const fetchStub = stubFetch([{ status: 401, body: { error: "auth_expired" } }]);
    const session = fakeSession({ refreshTo: null, refreshFailure: "refused" });
    try {
      await apiRequest({ path: "/api/v1/me" }, session);
      expect(fetchStub.calls).toBe(1);
      expect(session.ended).toEqual(["auth_expired"]);
    } finally {
      fetchStub.restore();
    }
  });

  // -------------------------------------------------------------------------
  // A REFRESH THAT NEVER REACHED A SERVER (native QA batch 2, D7)
  //
  // The port used to answer `null` for both "GoTrue refused this refresh token"
  // and "the refresh request never got there", and this layer ended the session
  // for both. One dead spot at the wrong moment therefore signed a person out
  // and made them retype a password, holding a refresh token nobody had revoked
  // — a forced re-login where a silent refresh was available a second later.
  // -------------------------------------------------------------------------
  it("does NOT end the session when the refresh could not reach a server", async () => {
    const fetchStub = stubFetch([{ status: 401, body: { error: "auth_expired" } }]);
    const session = fakeSession({ refreshTo: null, refreshFailure: "unreachable" });
    try {
      const result = await apiRequest({ path: "/api/v1/me" }, session);

      // THE ASSERTION THIS WHOLE ARM EXISTS FOR.
      expect(session.ended).toEqual([]);
      // Reported as what it was — a request that could not be made. Screens
      // render this as "revisá tu conexión" with a retry, not as a sign-out.
      expect(result.outcome).toBe("unreachable");
      // Still ONE refresh and no retry: the policy in this file's header is
      // unchanged, only the answer to a failure that means something else.
      expect(session.refreshes).toBe(1);
      expect(fetchStub.calls).toBe(1);
    } finally {
      fetchStub.restore();
    }
  });

  it("NEVER refreshes on session_shift_expired", async () => {
    // The refresh would SUCCEED — the token is valid at GoTrue, the 8-hour shift
    // is our policy — and the retry would be refused again, forever. The web app
    // paid for this as a redirect loop on 2026-07-04; the native shape is a
    // retry loop, and this assertion is the only thing standing between them.
    const fetchStub = stubFetch([{ status: 401, body: { error: "session_shift_expired" } }]);
    const session = fakeSession();
    try {
      const result = await apiRequest({ path: "/api/v1/me" }, session);
      expect(session.refreshes).toBe(0);
      expect(fetchStub.calls).toBe(1);
      expect(session.ended).toEqual(["session_shift_expired"]);
      expect(result.outcome).toBe("api-error");
    } finally {
      fetchStub.restore();
    }
  });

  it("ends the session on a 403 account refusal", async () => {
    for (const code of ["account_deactivated", "account_erased"] as const) {
      const fetchStub = stubFetch([{ status: 403, body: { error: code } }]);
      const session = fakeSession();
      try {
        await apiRequest({ path: "/api/v1/me" }, session);
        expect(session.refreshes).toBe(0);
        expect(session.ended).toEqual([code]);
      } finally {
        fetchStub.restore();
      }
    }
  });

  it("does NOT end a session that never existed", async () => {
    // Opening the app signed out must not fire "tu sesión venció" at somebody
    // who never had one.
    const fetchStub = stubFetch([{ status: 200, body: ME_OK }]);
    const session = fakeSession({ token: null });
    try {
      const result = await apiRequest({ path: "/api/v1/me" }, session);
      expect(result).toEqual({
        outcome: "api-error",
        code: "auth_required",
        retryAfterSeconds: null,
      });
      expect(fetchStub.calls).toBe(0);
      expect(session.ended).toEqual([]);
    } finally {
      fetchStub.restore();
    }
  });

  it("does not sign anyone out over a rate limit or a 500", async () => {
    for (const answer of [
      { status: 429, body: { error: "rate_limited" } },
      { status: 500, body: { error: "temporarily_unavailable" } },
    ]) {
      const fetchStub = stubFetch([answer]);
      const session = fakeSession();
      try {
        await apiRequest({ path: "/api/v1/me" }, session);
        expect(session.ended).toEqual([]);
        expect(session.refreshes).toBe(0);
      } finally {
        fetchStub.restore();
      }
    }
  });
});

describe("apiRequest — the payloadVersion gate", () => {
  it("refuses a payload from a future contract instead of guessing at it", async () => {
    const fetchStub = stubFetch([{ status: 200, body: { payloadVersion: 99 } }]);
    try {
      const result = await apiRequest(
        { path: "/api/v1/me", expectedPayloadVersion: ME_PAYLOAD_VERSION },
        fakeSession(),
      );
      // `toMatchObject` rather than `toEqual` since OBS-3: every reported
      // failure also carries the `correlationId` the screen prints, and this
      // test's subject is the version gate, not the key set.
      expect(result).toMatchObject({ outcome: "unsupported-version", received: 99 });
    } finally {
      fetchStub.restore();
    }
  });

  it("reports null — not NaN — when the version is missing or not a number", async () => {
    for (const body of [{}, { payloadVersion: "1" }]) {
      const fetchStub = stubFetch([{ status: 200, body }]);
      try {
        const result = await apiRequest(
          { path: "/api/v1/me", expectedPayloadVersion: ME_PAYLOAD_VERSION },
          fakeSession(),
        );
        expect(result).toMatchObject({ outcome: "unsupported-version", received: null });
      } finally {
        fetchStub.restore();
      }
    }
  });
});

describe("apiRequest — transport vs body", () => {
  it("does NOT blame the connection for a body it could not parse", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({
        status: 200,
        ok: true,
        headers: { get: () => null },
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON at position 0");
        },
      }) as unknown as Response) as typeof fetch;
    try {
      const result = await apiRequest({ path: "/api/v1/me" }, fakeSession());
      expect(result.outcome).toBe("malformed");
      expect(apiFailureMessage(result)).not.toContain("conexión");
    } finally {
      globalThis.fetch = original;
    }
  });

  // -------------------------------------------------------------------------
  // A6-cuenta-resiliencia-07 — THE STATUS IS READ BEFORE THE BODY
  // -------------------------------------------------------------------------
  it("reads a 503 with an unreadable body as an outage, not as a broken payload", async () => {
    // A load balancer's HTML 502, a deploy's 503, a captive portal's login
    // page. Every one of them arrived as "El servidor respondió algo que no
    // pudimos leer" — a sentence about JSON, in front of somebody who can only
    // act on the outage.
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({
        status: 503,
        ok: false,
        headers: { get: (name: string) => (name === "retry-after" ? "30" : null) },
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON at position 0");
        },
      }) as unknown as Response) as typeof fetch;
    try {
      const result = await apiRequest({ path: "/api/v1/me" }, fakeSession());
      expect(result).toEqual({
        outcome: "api-error",
        code: "temporarily_unavailable",
        retryAfterSeconds: 30,
      });
      expect(apiFailureMessage(result)).not.toContain("no pudimos leer");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("calls a dead connection unreachable", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError("Network request failed");
    }) as typeof fetch;
    try {
      const result = await apiRequest({ path: "/api/v1/me" }, fakeSession());
      expect(result.outcome).toBe("unreachable");
      expect(apiFailureMessage(result)).toContain("conexión");
    } finally {
      globalThis.fetch = original;
    }
  });
});
