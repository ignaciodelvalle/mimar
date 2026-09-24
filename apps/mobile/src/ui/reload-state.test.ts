// The one transition S-2 is about, tested where it lives.
//
// Nine screens shared the bug and now share this rule, so the rule is asserted
// once here and once per screen family in the screens' own tests — the screen
// tests prove the wiring, this one proves the decision.
//
// THE SECOND HALF (lote 1b, F3) IS THE ONE THAT WAS MISSING. "Keep the last good
// payload" branched only on the CURRENT state, so a 403 and a dead spot were the
// same event: a pet transferred away, a caretaker grant that ended, a revoked
// share — each one left the whole live credential on screen under "Lo que ves es
// lo último que pudimos leer." That sentence is true of an outage and false of a
// revocation, and it is false on the screen whose subject IS current custody.

import { describe, expect, it } from "@jest/globals";

import type { ApiResult } from "../api/client";
import { type ReadyState, isOutageShaped, loaded, reloadFailed } from "./reload-state";

type View = { rows: number };

/** The failure a dead spot produces. */
const OUTAGE: ApiResult<unknown> = { outcome: "unreachable", detail: "network" };
/** The failure a revoked grant produces. */
const REFUSAL: ApiResult<unknown> = {
  outcome: "api-error",
  code: "share_forbidden",
  retryAfterSeconds: null,
};

describe("reloadFailed — only the FIRST load may empty the screen", () => {
  it("keeps a payload that is already on screen and reports the failure beside it", () => {
    const current: ReadyState<View> = loaded({ rows: 2 });

    expect(reloadFailed(current, OUTAGE, "No pudimos conectarnos.")).toEqual({
      phase: "ready",
      view: { rows: 2 },
      staleFailure: "No pudimos conectarnos.",
    });
  });

  it("keeps whatever else the ready arm carries", () => {
    // SharesScreen holds a revealed token on its ready arm, the document holds
    // the face being read. Flattening those would log somebody out of a panel
    // they had open because a refresh failed.
    const current = { ...loaded({ rows: 2 }), revealed: "SHR-ABCD" };

    expect(reloadFailed(current, OUTAGE, "Se cayó.")).toEqual({
      phase: "ready",
      view: { rows: 2 },
      staleFailure: "Se cayó.",
      revealed: "SHR-ABCD",
    });
  });

  it("shows the full error when there is nothing to keep", () => {
    expect(reloadFailed({ phase: "loading" }, OUTAGE, "No pudimos conectarnos.")).toEqual({
      phase: "failed",
      message: "No pudimos conectarnos.",
    });
    expect(reloadFailed({ phase: "failed", message: "vieja" }, OUTAGE, "nueva")).toEqual({
      phase: "failed",
      message: "nueva",
    });
  });

  it("clears the stale banner when a read finally lands", () => {
    const stale = reloadFailed(loaded<View>({ rows: 2 }), OUTAGE, "No pudimos conectarnos.");

    expect(loaded({ rows: 3 })).toEqual({ phase: "ready", view: { rows: 3 }, staleFailure: null });
    // And the failure it replaces was really there, so the assertion above is
    // not passing on a banner that never existed.
    expect(stale).toHaveProperty("staleFailure", "No pudimos conectarnos.");
  });
});

// ---------------------------------------------------------------------------
// lote 1b F3 — A REVOCATION IS NOT A REFRESH HICCUP
// ---------------------------------------------------------------------------

describe("reloadFailed — what the failure was ABOUT decides too", () => {
  it("EMPTIES the screen when the server refused this reader's access", () => {
    // The measured case: a share revoked while the panel was open, a caretaker
    // grant that ended, a pet transferred away. Keeping the payload renders a
    // credential this person may no longer read, over a sentence that blames the
    // network for it.
    const current: ReadyState<View> = loaded({ rows: 2 });

    expect(reloadFailed(current, REFUSAL, "Ya no tenés acceso.")).toEqual({
      phase: "failed",
      message: "Ya no tenés acceso.",
    });
  });

  it("empties it for a 404 too — the thing may simply be gone", () => {
    const gone: ApiResult<unknown> = {
      outcome: "api-error",
      code: "not_found",
      retryAfterSeconds: null,
    };

    expect(reloadFailed(loaded<View>({ rows: 2 }), gone, "No encontramos esto.")).toEqual({
      phase: "failed",
      message: "No encontramos esto.",
    });
  });

  it("still KEEPS it for the two api-error codes that are outages", () => {
    // NON-VACUITY for the split above: a rule that emptied on every `api-error`
    // would satisfy the two assertions above and re-open S-2 for exactly the
    // failures S-2 was written about — a deploy and a rate limit say nothing
    // whatsoever about this reader's access.
    for (const code of ["temporarily_unavailable", "rate_limited"] as const) {
      const outage: ApiResult<unknown> = { outcome: "api-error", code, retryAfterSeconds: null };

      expect(reloadFailed(loaded<View>({ rows: 2 }), outage, "Probá en un rato.")).toEqual({
        phase: "ready",
        view: { rows: 2 },
        staleFailure: "Probá en un rato.",
      });
    }
  });

  it("classifies each outcome the way the screens depend on", () => {
    expect(isOutageShaped({ outcome: "unreachable", detail: "network" })).toBe(true);
    expect(isOutageShaped({ outcome: "malformed", detail: "bad json" })).toBe(true);
    // An old build against a new server must SEE "actualizá la app", not go on
    // reading stale content under a banner.
    expect(isOutageShaped({ outcome: "unsupported-version", received: 2 })).toBe(false);
    expect(isOutageShaped({ outcome: "ok", payload: null })).toBe(false);
  });
});
