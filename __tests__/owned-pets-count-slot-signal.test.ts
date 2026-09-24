// D.8 (2026-07-30) — the owned-pets signal behind the tab-bar centre slot.
//
// The citizen tab bar's centre slot said "Asentar" and pointed at
// /inicio?sheet=anotar. With ZERO pets /inicio redirects to /mis-mascotas,
// where ?sheet=anotar is inert — the most emphasised control in the whole
// citizen shell did nothing for exactly the first-run owner. Fixing it needs a
// has-pets signal in app/(app)/layout.tsx, which previously touched neither
// `ownerships` nor `pets`.
//
// The agreed cost is ONE indexed count per request, memoized with React
// cache() so any sibling consumer in the same render pass shares it.
//
// WHY THIS GUARD IS STRUCTURAL, NOT BEHAVIOURAL: React's cache() only memoizes
// inside a real server render pass. Probed on 2026-07-30 in this exact harness
// — a cache()-wrapped spy called twice with the same argument ran TWICE both
// outside a render and inside renderToStaticMarkup (2 calls in both cases).
// The module header of lib/infra/request-cache.ts says the same thing. So
// "once per request" cannot be asserted by calling it; what CAN be pinned is
// the shape that makes it true: the cache() wrapper, a single call site, and a
// userId-only key.
//
// Source-scan style, same as owner-process-clarity-19.test.ts: no render, no DB.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

const cacheSrc = read("lib", "infra", "request-cache.ts");
const layoutSrc = read("app", "(app)", "layout.tsx");
const tabBarSrc = read("components", "layout", "CitizenTabBar.tsx");

describe("getOwnedPetsCountCached — the helper", () => {
  it("is memoized with React cache(), like the five helpers beside it", () => {
    expect(cacheSrc).toMatch(/export const getOwnedPetsCountCached = cache\(/);
  });

  it("counts ACTIVE ownerships for the user, on the owner_user_id index", () => {
    const helper = cacheSrc.slice(cacheSrc.indexOf("export const getOwnedPetsCountCached"));
    const body = helper.slice(0, helper.indexOf("\n});"));
    expect(body).toContain(".from(ownerships)");
    expect(body).toContain("eq(ownerships.ownerUserId, userId)");
    // Ended ownerships are transfers/relinquishments — they must not keep a
    // pets-less owner on the capture slot.
    expect(body).toContain("isNull(ownerships.endedAt)");
    expect(body).toContain("count()");
  });

  // PRE-PUSH REVIEW 2026-07-30 — the fix did not fire for the owner it matters
  // most to. DEATH DOES NOT END AN OWNERSHIP (no code path sets `ended_at` on
  // death; In memoriam is deliberately still your pet), so an owner whose only
  // pet had died still counted >= 1 → "Asentar" → /inicio?sheet=anotar →
  // redirect to /mis-mascotas with an inert sheet. The silent no-op D.8 exists
  // to remove, landing on a grieving owner.
  it("excludes DECEASED pets — the count is LIVE pets, not live ownerships", () => {
    const helper = cacheSrc.slice(cacheSrc.indexOf("export const getOwnedPetsCountCached"));
    const body = helper.slice(0, helper.indexOf("\n});"));
    expect(body).toContain("innerJoin(pets");
    expect(body).toContain('ne(pets.status, "deceased")');
  });

  // ONE definition, not a third variant. `/inicio` decides "does this owner have
  // anywhere to land" with fetchLivePetsForCarouselRanking, whose predicate is
  // active ownership + not deceased. The tab-bar slot must be a COUNT of exactly
  // that set, or the slot and the destination it points at disagree again.
  it("reuses the SAME live-pets predicate /inicio redirects on", () => {
    const canonical = read("lib", "analytics", "owner-dashboard.ts");
    const fn = canonical.slice(
      canonical.indexOf("export async function fetchLivePetsForCarouselRanking"),
    );
    const body = fn.slice(0, fn.indexOf("\n}"));
    for (const clause of [
      "eq(ownerships.ownerUserId, userId)",
      "isNull(ownerships.endedAt)",
      'ne(pets.status, "deceased")',
    ]) {
      expect(body, `/inicio's own predicate must contain ${clause}`).toContain(clause);
      expect(cacheSrc, `the cached count must reuse ${clause}`).toContain(clause);
    }
  });

  // THE CACHE-KEY TRAP (precedent: getOrgQueueCountsCached, whose array arg had
  // to be flattened to a string for exactly this reason). React cache() keys on
  // argument identity/value, so a second parameter — an options object, a
  // filter, a flag — means a SECOND cache entry and a second round-trip in the
  // same pass. The signature is userId-only and must stay that way.
  it("takes userId and NOTHING else — one argument, one cache entry", () => {
    const signature = cacheSrc.match(
      /export const getOwnedPetsCountCached = cache\(([\s\S]*?)=>/,
    )?.[1];
    expect(signature).toBeDefined();
    expect(signature?.trim()).toBe("async (userId: string): Promise<number>");
  });
});

describe("the layout wires the signal exactly once", () => {
  it("calls getOwnedPetsCountCached once, with user.id", () => {
    const calls = layoutSrc.match(/getOwnedPetsCountCached\(/g) ?? [];
    expect(calls.length, "one call site — a second one is a second round-trip").toBe(1);
    expect(layoutSrc).toContain("getOwnedPetsCountCached(user.id)");
  });

  it("resolves it alongside the existing reads, not as an extra await hop", () => {
    // Matches on the GUARANTEE — the three reads share one Promise.all — rather
    // than on the literal `await Promise.all([`, which is a shape. The layout
    // now wraps that Promise.all in loadWithTimeout (the whole owner portal
    // hangs if these counters hang, and a layout has no error boundary above
    // it), so the `await` moved one call outwards while the guarantee did not
    // change. A test that pins the shape blocks a correct fix and reads like a
    // real regression when it fires.
    const start = layoutSrc.indexOf("Promise.all([");
    expect(start, "the layout no longer batches its shell reads").toBeGreaterThan(-1);
    const promiseAll = layoutSrc.slice(start, layoutSrc.indexOf("]),", start));
    expect(promiseAll).toContain("getOwnedPetsCountCached(user.id)");
    expect(promiseAll).toContain("getUnreadCountCached(user.id)");
    expect(promiseAll).toContain("getOrgMembershipsCached(user.id)");
  });

  it("batches them in exactly ONE Promise.all", () => {
    // The half of the guarantee the slice above cannot express: splitting the
    // three reads across two Promise.alls would still put each inside "a"
    // Promise.all while costing the extra round-trip hop this suite exists to
    // prevent.
    expect((layoutSrc.match(/Promise\.all\(\[/g) ?? []).length).toBe(1);
  });

  it("threads the number into the tab bar", () => {
    expect(layoutSrc).toContain(
      "<CitizenTabBar nav={shell.nav} ownedPetsCount={ownedPetsCount} />",
    );
  });
});

describe("the tab bar consumes it without a silent default", () => {
  it("declares ownedPetsCount as a required number prop", () => {
    // A default would let a future caller silently pick a branch — and the
    // wrong branch here is the no-op that D.8 exists to remove.
    expect(tabBarSrc).toMatch(/ownedPetsCount:\s*number;/);
    expect(tabBarSrc).not.toMatch(/ownedPetsCount\s*=\s*\d/);
    expect(tabBarSrc).not.toMatch(/ownedPetsCount\?:/);
  });

  it("routes the zero case to the alta, not to the inert capture URL", () => {
    expect(tabBarSrc).toContain("const showAlta = !currentPetToken && ownedPetsCount === 0;");
    expect(tabBarSrc).toContain('"/mis-mascotas/nueva"');
    expect(tabBarSrc).toContain('showAlta ? "Registrar mascota" : "Asentar"');
  });
});
