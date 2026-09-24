// React.cache-based dedup for shared base-population queries.
//
// Within a single server render pass, multiple tiles on the same dashboard can
// call getActivePetCount(ctx) and receive the same memoized result — one DB
// round-trip regardless of how many tiles use it.
//
// React.cache is request-scoped (discarded at end of request). This is NOT
// cross-request caching — pages stay force-dynamic. Cross-request caching
// (unstable_cache / ISR) is out of scope until real volume justifies it (see
// umbrella §6).
//
// NOTE: deliberately no `import "server-only"` — same rationale as
// lib/request-cache.ts (seed scripts import transitively through guards).

import { cache } from "react";

import { count } from "drizzle-orm";

import { db, pets } from "@/db";

import type { ProjectionContext } from "./context";
import { ctxKey } from "./context";
import { activePetsCondition, dogsInScopeCondition } from "./population";

/**
 * Memoized count of active pets in scope.
 * The cache key is the stable ctxKey(ctx) string — two contexts with identical
 * scope+period produce the same key and share one DB query per request.
 */
export const getActivePetCount = cache(async (_key: string, ctx: ProjectionContext) => {
  const condition = activePetsCondition(ctx);
  const [row] = await db.select({ n: count() }).from(pets).where(condition);
  return row?.n ?? 0;
});

/**
 * Memoized count of dogs in scope.
 */
export const getDogCount = cache(async (_key: string, ctx: ProjectionContext) => {
  const condition = dogsInScopeCondition(ctx);
  const [row] = await db.select({ n: count() }).from(pets).where(condition);
  return row?.n ?? 0;
});

/**
 * Convenience wrappers that derive the cache key automatically.
 * Callers use these instead of the raw cached functions.
 */
export async function cachedActivePetCount(ctx: ProjectionContext): Promise<number> {
  return getActivePetCount(ctxKey(ctx), ctx);
}

export async function cachedDogCount(ctx: ProjectionContext): Promise<number> {
  return getDogCount(ctxKey(ctx), ctx);
}
