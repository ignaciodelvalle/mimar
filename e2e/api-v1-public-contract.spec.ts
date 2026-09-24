import { expect, test } from "@playwright/test";

import { SEED_PROFILE, seedFixtureVerdict } from "./_seed-profile";

/**
 * `/api/v1` — the ANONYMOUS half, against a deployed origin.
 *
 * Two routes a native client hits before it has an account at all:
 * `/api/v1/localities` (a signup asks "¿dónde vivís?" before there is a session)
 * and `/api/v1/pets/{token}/credential` (what a stranger's camera resolves to).
 *
 * WHAT THIS CATCHES THAT THE UNIT SUITE CANNOT
 * ---------------------------------------------------------------------------
 * The handlers are pinned by `__tests__/api-v1-localities-route.test.ts` and
 * `api-v1-credential-route.test.ts`. What those cannot see is everything BETWEEN
 * the phone and the handler, and on these two routes that gap has a named cost:
 *
 *   · `Cache-Control: no-store` is NOT inherited (§4). Middleware stamps it from
 *     a path-prefix allowlist `/api/` is not on, so every response sets it
 *     itself. The privacy class this closed on 2026-07-07 was REAL — a revoked
 *     share and a found pet served stale from the CDN at the exact shared URL —
 *     and it is a CDN-level defect, which means only a deployed origin can prove
 *     it stays closed. A unit test asserting the header proves the handler set
 *     it, not that Vercel kept it.
 *   · The 404 on an unknown token must be byte-identical to the 404 on a
 *     soft-deleted pet (PO-4: an erased subject's credential must be
 *     indistinguishable from one that never existed). An edge layer that starts
 *     answering its own 404 for one and not the other reopens that oracle
 *     without touching a line of application code.
 *
 * NO HARDCODED TOKEN. The credential case discovers a real one from the
 * target's own `/adoptar` catalogue at runtime — `e2e/README.md`'s rule, and the
 * reason is that a token baked into a spec is a fixture that silently stops
 * existing. Absence is routed through `seedFixtureVerdict`, so it SKIPS with a
 * named coverage hole on a bootstrap seed and FAILS on the nightly staging pass
 * where the catalogue is supposed to have listings.
 */

/** Two characters is the documented floor for a locality search. */
const SHORT_QUERY = "c";

test.describe("/api/v1/localities — the pre-account typeahead", () => {
  test("answers the envelope and the five projected fields", async ({ request }) => {
    const res = await request.get("/api/v1/localities?q=cor", { failOnStatusCode: false });
    expect(res.status()).toBe(200);

    const body = (await res.json()) as {
      payloadVersion: number;
      issuedAt: string;
      staleAfter: string;
      results: Array<Record<string, unknown>>;
    };

    // §6 — the three envelope fields every READ carries. `staleAfter` after
    // `issuedAt`, or the field means nothing.
    expect(typeof body.payloadVersion).toBe("number");
    expect(Date.parse(body.staleAfter)).toBeGreaterThan(Date.parse(body.issuedAt));
    expect(Array.isArray(body.results)).toBe(true);

    // The catalogue is INDEC reference data and is not seed-dependent: a
    // national locality list with no match for "cor" is a broken deploy, not a
    // thin seed, so this ASSERTS instead of gating.
    expect(body.results.length, "the INDEC catalogue must match 'cor'").toBeGreaterThan(0);

    // Projected DOWN, on purpose. The catalogue row also carries the
    // `ar_localities` uuid (the app's structural FK) and a `matchKind` ranking
    // signal; neither belongs on a wire, and a client that started receiving
    // them would start depending on them.
    //
    // `indecId` WIDENED this projection on 2026-09-07 (lote L2, commit
    // 31ab9247a) and that was deliberate, so the list moves with it rather than
    // the assertion being loosened. The homonym fix needs it: the picker shows
    // the department to tell two same-named localities apart and then had to
    // send something the server could resolve BY IDENTITY, because
    // `localityByName` is province-scoped and takes the alphabetically-first
    // department — and the INDEC catalogue ships 68 (province, name)
    // collisions. Jurisdiction decides the responding authority, so the id is
    // the payload, not a leak.
    //
    // WHY THIS TEST CAUGHT IT AND NOTHING ELSE DID: it is the only fence on the
    // shape of a PUBLIC wire, and it lives in e2e — which is not in
    // `pnpm verify` nor in `pnpm test:verified` (CLAUDE.md says so out loud).
    // Six green gates went past this. The `ar_localities` uuid staying off the
    // wire is still the rule; `indecId` is a published national reference
    // number, which is a different thing.
    expect(Object.keys(body.results[0]).sort()).toEqual([
      "departmentName",
      "indecId",
      "localityName",
      "localitySlug",
      "provinceCode",
      "provinceName",
    ]);
    // The structural FK must STILL not travel — that half of the rule did not
    // change, and without this line the assertion above would accept it.
    expect(body.results[0]).not.toHaveProperty("id");
    expect(body.results[0]).not.toHaveProperty("matchKind");
  });

  test("a one-character query is 200 with no results, NOT an error", async ({ request }) => {
    // A typeahead fires on every keystroke; the first one is not a client error
    // and must not be reported as one, or every native search box flashes a
    // message on its way to working. Pinned here because "tighten the input
    // validation" is a natural-looking change that would break it.
    const res = await request.get(`/api/v1/localities?q=${SHORT_QUERY}`, {
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).results).toEqual([]);
  });

  test("an unknown province is 400, not a silent full-country search", async ({ request }) => {
    // A client that asked for one province and got every province would render
    // the wrong list with no way to notice.
    const res = await request.get("/api/v1/localities?q=cor&province=AR-ZZ", {
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
  });

  test("is not cached at the edge", async ({ request }) => {
    const res = await request.get("/api/v1/localities?q=cor", { failOnStatusCode: false });
    expect(res.headers()["cache-control"]).toContain("no-store");
  });
});

test.describe("/api/v1/pets/{token}/credential — what a camera resolves to", () => {
  test("serves a discovered public token, uncached, with the envelope", async ({ request }) => {
    // Discovered at runtime from the target's own catalogue — never hardcoded.
    const listing = await request.get("/adoptar", { failOnStatusCode: false });
    const token = (await listing.text()).match(/\/adoptar\/(DIM-[A-Z0-9-]+)/)?.[1] ?? null;

    const verdict = seedFixtureVerdict(
      token ? 1 : 0,
      "published adoption listing on /adoptar to take a public token from",
      "the deployed /api/v1 credential read (envelope + no-store)",
    );
    test.skip(verdict.verdict === "skip", verdict.verdict === "skip" ? verdict.reason : "");
    if (verdict.verdict === "fail") throw new Error(verdict.reason);
    if (!token) return;

    const res = await request.get(`/api/v1/pets/${token}/credential`, { failOnStatusCode: false });
    expect(res.status(), `credential for ${token} (seed profile "${SEED_PROFILE}")`).toBe(200);

    // THE ONE THAT NEEDS A DEPLOYED ORIGIN. A credential served stale from a CDN
    // is the 2026-07-07 privacy class: a found pet still showing "SE BUSCA" and
    // the owner's phone at the exact URL somebody already shared.
    expect(res.headers()["cache-control"], "a credential must never be cacheable").toContain(
      "no-store",
    );

    const body = (await res.json()) as { payloadVersion: number; issuedAt: string };
    expect(typeof body.payloadVersion).toBe("number");
    expect(Number.isNaN(Date.parse(body.issuedAt))).toBe(false);
  });

  test("an unknown token is a plain 404 with the shared envelope", async ({ request }) => {
    // Uses the real alphabet (`ABCDEFGHJKMNPQRSTUVWXYZ23456789` — no 0/O/1/I/l,
    // lib/infra/publicToken.ts) so this exercises the LOOKUP rather than a
    // format rejection, which is a different branch answering the same status.
    //
    // The body must be exactly `{ error: "not_found" }` — the same answer a
    // SOFT-DELETED pet gets. An edge layer that starts serving its own HTML 404
    // for one shape and not the other turns this endpoint back into an existence
    // oracle without any application code changing.
    const res = await request.get("/api/v1/pets/DIM-ZZZZ-9999/credential", {
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(404);
    expect(res.headers()["content-type"]).toContain("application/json");
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
