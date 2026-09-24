// lib/infra/api-v1.ts — the ONE way a `/api/v1` handler answers (RN-1 G1-G3).
//
// Before this module the envelope discipline was file-local: the first
// endpoint funnelled its four status codes through a private `credentialJson`
// helper, which is the right shape for ONE file and nothing for the second.
// These helpers are what scripts/check-api-v1-envelope.ts requires every
// `/api/v1` route to use, so what they guarantee must be proved here, not
// assumed from their names.

import { describe, expect, it } from "vitest";

import { API_V1_ERROR_CODES, PUBLIC_CREDENTIAL_STALE_AFTER_MS } from "@dim/contract/api";

import { apiV1Envelope, apiV1Error, apiV1Json } from "@/lib/infra/api-v1";

describe("apiV1Json", () => {
  it("ALWAYS sets cache-control: no-store and a charset-qualified JSON content-type", async () => {
    // §4: no-store is NOT inherited — middleware's allowlist is a path-prefix
    // list `/api/` is not on. And `charset=utf-8` is spelled out because a
    // native client's JSON parser should never have to guess the encoding of
    // "Ushuaia" or "María".
    const res = apiV1Json({ ok: true }, { status: 200 });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("merges extra headers WITHOUT letting them override no-store", () => {
    const res = apiV1Json(
      {},
      { status: 503, headers: { "retry-after": "30", "cache-control": "public, max-age=60" } },
    );
    expect(res.headers.get("retry-after")).toBe("30");
    // The caller cannot opt a `/api/v1` response back into a CDN.
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("apiV1Error", () => {
  it("answers the single-key { error } envelope from the agreed vocabulary (§2, §3)", async () => {
    const res = apiV1Error("not_found", 404);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("carries extra headers (the 503's retry-after) and nothing else", async () => {
    const res = apiV1Error("temporarily_unavailable", 503, { "retry-after": "30" });
    expect(res.headers.get("retry-after")).toBe("30");
    expect(Object.keys(await res.json())).toEqual(["error"]);
  });

  it("is typed against the contract package's vocabulary (compile-time pin)", () => {
    // Every code the contract publishes must be accepted; a string outside it
    // is a type error, which is what keeps a route from inventing one.
    for (const code of API_V1_ERROR_CODES) {
      expect(apiV1Error(code, 400).status).toBe(400);
    }
    // @ts-expect-error — not in ApiV1ErrorCode
    apiV1Error("made_up_code", 400);
  });
});

describe("apiV1Envelope", () => {
  it("emits payloadVersion / issuedAt / staleAfter (§6) from an explicit clock", () => {
    const now = new Date("2026-08-22T12:00:00.000Z");
    const env = apiV1Envelope({ payloadVersion: 1, issuedAt: now, staleAfterMs: 300_000 });
    expect(env).toEqual({
      payloadVersion: 1,
      issuedAt: "2026-08-22T12:00:00.000Z",
      staleAfter: "2026-08-22T12:05:00.000Z",
    });
  });

  it("defaults issuedAt to now", () => {
    const before = Date.now();
    const env = apiV1Envelope({ payloadVersion: 1, staleAfterMs: 1_000 });
    const issued = Date.parse(env.issuedAt);
    expect(issued).toBeGreaterThanOrEqual(before);
    expect(Date.parse(env.staleAfter) - issued).toBe(1_000);
  });

  it("the credential's stale-after policy lives in the contract package", () => {
    // A native client needs the number to show "esto es lo que el servidor
    // sabía a las 14:32" — so it is published next to the payload version,
    // not buried in the app's projection file.
    expect(PUBLIC_CREDENTIAL_STALE_AFTER_MS).toBe(5 * 60_000);
  });
});
