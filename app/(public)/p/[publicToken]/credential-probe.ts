// The /p/{token} route family's ONE per-request read of "does this token
// exist?" — throttled first, memoised, shared by the layout, the page and
// `generateMetadata`.
//
// WHY THIS EXISTS (2026-09-23, second pass after a pre-push review).
// ---------------------------------------------------------------------------
// `loading.tsx` wraps the page (and `/encontre`, `/sighting`) in an automatic
// Suspense boundary, so the page's own `notFound()` fires after a 200 has
// already streamed. The landing `layout.tsx` sits OUTSIDE that boundary — it
// is the parent of the segment whose loading UI it is — so it is the one place
// a `notFound()` still sets a real 404. The layout therefore has to know
// whether the token exists before `{children}` renders.
//
// The first attempt had the layout call the full `lookupPublicCredential` door:
// a second throttle CHARGE per visit (the limiter increments) and the whole
// view-data fan-out a second time, just to read `.status`. This module is the
// replacement, and its two properties are the review's two requirements:
//
//   1. THROTTLE BEFORE ROW, ALWAYS. There is no export here that reads the pet
//      row without spending the per-IP limiter first. An UNthrottled existence
//      probe would turn 404-vs-200 into a free oracle over the 31^8 keyspace;
//      __tests__/public-token-throttle-coverage.test.ts classifies this file as
//      a DIRECT-form resolver and fences the ordering.
//   2. ONCE PER REQUEST. `React.cache` keys on primitives (token, surface), so
//      the layout, the page (via `pageLookupDeps.findPet`, injected into the
//      door) and `generateMetadata` share ONE throttle charge — the limiter is
//      itself memoised in lib/infra/public-token-throttle.ts — and ONE row
//      read. The heavy `loadCredentialViewData` fan-out stays in the page,
//      behind `loading.tsx`, exactly where it was.
//
// WHICH BUCKET. Each route in this family has always had its own limiter
// bucket (`public_token_page`, `public_token_encontre`,
// `public_token_sighting`). The layout wraps all three, so it charges the
// bucket of the route actually being rendered (from middleware's
// `x-pathname`) — and because that charge is memoised, the sibling page's own
// `isPublicTokenReadThrottled("public_token_encontre")` reads the SAME answer.
// A visit to /encontre therefore costs what it cost before this fix: one
// charge on its own bucket, nothing on `public_token_page`.

import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { cache } from "react";

import { withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { publicPetByToken } from "@/lib/infra/public-pet-lookup";
import { isPublicTokenReadThrottled } from "@/lib/infra/public-token-throttle";
import { loadCredentialViewData } from "@/src/modules/pets/application/read/load-public-credential";
import {
  type LookupDeps,
  PET_ROW_BUDGET_MS,
  type PublicCredentialPetRow,
  selectPublicCredentialPetRow,
} from "@/src/modules/pets/application/read/lookup-public-credential";

/** The three routes under the landing layout — each with its own bucket. */
export type CredentialSurface = "page" | "encontre" | "sighting";

/**
 * Which route under `/p/{token}` is rendering, from middleware's `x-pathname`.
 *
 * Anything unrecognised (header absent, an unexpected sub-path) answers
 * `page`. That default can only ever over-charge `public_token_page` by one;
 * it can never skip a charge, because the probe always charges SOME bucket
 * before it reads the row.
 */
export function credentialSurfaceFromPath(pathname: string | null | undefined): CredentialSurface {
  const match = pathname?.match(/^\/p\/[^/]+\/(encontre|sighting)(?:\/|$)/);
  return match ? (match[1] as CredentialSurface) : "page";
}

/**
 * How long the landing layout waits for the probe before letting the skeleton
 * stream. Shorter than the probe's own pet-row budget (PET_ROW_BUDGET_MS) on
 * purpose — see "WHAT THE GATE COSTS A VISITOR" in ./layout.tsx. Lives here
 * because a layout file may only export what Next allows.
 */
export const LAYOUT_PROBE_BUDGET_MS = 1500;

/**
 * True while Next is rendering a router PREFETCH of this route, not a visit.
 *
 * WHY THE PROBE SKIPS IT (third pass, 2026-09-23). Next 15 prefetches a
 * dynamic route down to its nearest `loading.tsx` — which renders this route's
 * layout and resolves `generateMetadata`, but NOT the page. /perdidas and the
 * government lost-pet list render one `<Link href="/p/…">` per card, so every
 * card scrolled into view cost one `public_token_page` limiter write and one
 * pet-row read: a visitor browsing a page of lost pets could exhaust the same
 * per-IP budget a finder needs, without opening a single credential. A
 * prefetch that skips the probe reads nothing, so it answers nothing — there is
 * no existence oracle to throttle. The navigation that follows is a separate
 * request, charged and gated like any visit.
 *
 * WHY NOT `headers()` — MEASURED, NOT ASSUMED. The prefetch is signalled by
 * `next-router-prefetch: 1` (with `rsc: 1`), and the first version of this fix
 * read those two headers. It passed its unit tests and FAILED on the wire: a
 * prefetch still wrote a `rate_limit_buckets` row. Next removes every flight
 * header (`rsc`, `next-router-prefetch`, `next-router-segment-prefetch`, …)
 * from what `headers()` returns (next/dist/server/async-storage/
 * request-store.js `getHeaders`), and hides them from middleware too
 * (server/web/adapter.js). So user code cannot see them at all.
 *
 * WHAT IS READ INSTEAD. Next parses those headers once per render
 * (app-render.js `parseRequestHeaders`: `isPrefetchRequest` is
 * `next-router-prefetch === "1"`) and records the answer on the work store it
 * runs the render in — the same store `next/headers` itself reads. That is a
 * Next-internal module, so this is pinned FOUR ways: the Next version is
 * locked in package.json (an exact `15.5.24`, not a caret range — a caret
 * would let `pnpm install` move the file the next point pins without anyone
 * deciding to), credential-probe.test.ts runs this against the real store, the
 * commit carries the curl evidence against `next start`, and a CANARY in
 * credential-probe.test.ts reads the installed Next package's OWN source on
 * every run and fails loudly if either line this file depends on
 * (`app-render.js`'s header assignment, `work-store.js` threading
 * `isPrefetchRequest` into `createWorkStore`) is gone — the first three pins
 * would not have caught that; they exercise this file's behaviour, not Next's
 * source. If a future Next drops the field, `getStore()?.isPrefetchRequest` is
 * `undefined` and this answers `false`: the probe runs and a prefetch is
 * charged again. That is the safe direction — over-charging, never an
 * unthrottled read.
 *
 * The value `2` (a runtime prefetch, cache components only) does not set the
 * flag; Next renders it like a visit and it is probed like one.
 *
 * A CRAFTED REQUEST gains nothing from the flag. Next sets it from the header
 * alone, so a plain HTML GET carrying `next-router-prefetch: 1` also skips the
 * probe — and Next then renders it as a prefetch too: the skeleton only, no
 * page, no metadata read (measured 2026-09-23: 200, no pet name in the body,
 * no limiter row). Valid and unknown tokens get byte-identical prefetch
 * payloads once the token itself is masked, so skipping the throttle here
 * opens no existence oracle.
 */
export function isRouterPrefetchRender(): boolean {
  return workAsyncStorage.getStore()?.isPrefetchRequest === true;
}

/**
 * What the probe learned. `unavailable` is a DB failure or a blown budget — it
 * is NOT `not_found` (an outage must never read as "this token does not
 * exist"), so the layout lets the page render its degraded card.
 */
export type CredentialProbe =
  | { status: "throttled" }
  | { status: "not_found" }
  | { status: "unavailable"; error: unknown }
  | { status: "found"; row: PublicCredentialPetRow };

/**
 * Throttle, then the pet row — once per request per (token, surface).
 *
 * It does not report errors: the page's door receives the same rejection
 * through `pageLookupDeps.findPet` and reports it once, as
 * `public-credential/pet-row`, exactly as before.
 */
export const probePublicCredential = cache(
  async (publicToken: string, surface: CredentialSurface): Promise<CredentialProbe> => {
    // One LITERAL guard call per surface, never a computed bucket (third pass,
    // 2026-09-23). The first version indexed a `SURFACE_BUCKET` map, which the
    // coverage fence could not read — its bucket census only sees string
    // literals — so "each route its own bucket" silently skipped this file.
    // The fence now requires a literal on every direct-form guard, and names
    // the two buckets this probe shares with its sibling pages on purpose.
    let throttled: boolean;
    switch (surface) {
      case "encontre":
        throttled = await isPublicTokenReadThrottled("public_token_encontre");
        break;
      case "sighting":
        throttled = await isPublicTokenReadThrottled("public_token_sighting");
        break;
      case "page":
        throttled = await isPublicTokenReadThrottled("public_token_page");
        break;
    }
    if (throttled) return { status: "throttled" };
    try {
      const row = await withDbBudgetOrThrow(
        findPetRow(publicToken),
        PET_ROW_BUDGET_MS,
        "GET /p/[publicToken] pet-row",
      );
      return row ? { status: "found", row } : { status: "not_found" };
    } catch (error) {
      return { status: "unavailable", error };
    }
  },
);

/**
 * The pet row + primary photo — the SAME query as the door's default
 * `findPet`, defined once in the door module (`selectPublicCredentialPetRow`)
 * so the two cannot drift. PO-4: soft-deleted pets do not resolve
 * (`publicPetByToken` filters them in the QUERY). The token predicate is
 * written HERE, not inside the shared query, on purpose: it is what the
 * coverage fence reads as "this file resolves a token", and it sits inside
 * `probePublicCredential`'s export block, after the guard above.
 */
async function findPetRow(publicToken: string): Promise<PublicCredentialPetRow | undefined> {
  return selectPublicCredentialPetRow(publicPetByToken(publicToken));
}

/**
 * The door's collaborators for `/p/{token}`'s page: its `findPet` answers from
 * the memoised probe, so the page's `lookupPublicCredential` call reuses the
 * row the layout already read.
 *
 * The door still runs its own throttle port FIRST (the order is its contract);
 * that port lands on the same memoised charge, so it costs nothing. `throttled`
 * cannot reach `findPet` for the same reason — the door returns before calling
 * it — and is answered with a throw rather than `undefined`, because
 * `undefined` means "not found" and would 404 a caller who is merely limited.
 */
export const pageLookupDeps: LookupDeps = {
  findPet: async (publicToken) => {
    const probe = await probePublicCredential(publicToken, "page");
    switch (probe.status) {
      case "found":
        return probe.row;
      case "not_found":
        return undefined;
      case "unavailable":
        throw probe.error;
      case "throttled":
        throw new Error("public credential probe throttled after the door's throttle passed");
    }
  },
  loadViewData: loadCredentialViewData,
  withBudget: withDbBudgetOrThrow,
};
