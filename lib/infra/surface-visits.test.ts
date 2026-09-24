// Integration tests for lib/infra/surface-visits.ts — the per-user "have you
// been here" watermark backing the /gob first-run onboarding checklist
// (T4-O3, table user_surface_visits, migration 0244).
//
// Coverage:
//   1. hasVisitedSurfaces returns EMPTY for a user who has never visited
//      (never a false positive from a missing row).
//   2. recordSurfaceVisit inserts first_visited_at on the FIRST call.
//   3. A second recordSurfaceVisit for the SAME surface advances last_seen_at
//      but leaves first_visited_at untouched (the mutation this guards
//      against: an upsert that resets the "first" timestamp on every visit).
//   4. hasVisitedSurfaces reflects only surfaces actually recorded — visiting
//      "panorama" never marks "casos" as visited (cross-talk guard).
//   5. Isolation: one user's recorded visits are invisible to
//      hasVisitedSurfaces for a DIFFERENT user (the per-user equivalent of
//      "an operator of another jurisdiction sees their own state").
//
// Runs against the local Postgres instance. Seeds two throwaway `profiles`
// rows and cleans up in afterAll (FK-safe: user_surface_visits rows cascade
// with the profile, but we delete them explicitly first to keep the profile
// delete itself simple to reason about).

import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, profiles, userSurfaceVisits } from "@/db";
import { hasVisitedSurfaces, recordSurfaceVisit } from "@/lib/infra/surface-visits";

let userAId: string;
let userBId: string;

beforeAll(async () => {
  const [a] = await db
    .insert(profiles)
    .values({ id: crypto.randomUUID(), displayName: "Surface Visits Test A", role: "govt" })
    .returning({ id: profiles.id });
  userAId = a.id;

  const [b] = await db
    .insert(profiles)
    .values({ id: crypto.randomUUID(), displayName: "Surface Visits Test B", role: "govt" })
    .returning({ id: profiles.id });
  userBId = b.id;
});

afterAll(async () => {
  await db.delete(userSurfaceVisits).where(inArray(userSurfaceVisits.userId, [userAId, userBId]));
  await db.delete(profiles).where(inArray(profiles.id, [userAId, userBId]));
});

describe("hasVisitedSurfaces — no false positives", () => {
  it("returns an empty set for a user with no recorded visits", async () => {
    const visited = await hasVisitedSurfaces(userAId, ["gob_home", "panorama", "casos", "cola"]);
    expect(visited.size).toBe(0);
  });
});

describe("recordSurfaceVisit — first_visited_at vs last_seen_at", () => {
  it("sets first_visited_at on the first call", async () => {
    await recordSurfaceVisit(userAId, "panorama");
    const [row] = await db
      .select()
      .from(userSurfaceVisits)
      .where(eq(userSurfaceVisits.userId, userAId));
    expect(row).toBeDefined();
    expect(row.surface).toBe("panorama");
    expect(row.firstVisitedAt).toBeInstanceOf(Date);
  });

  it("a second visit advances last_seen_at but NEVER moves first_visited_at", async () => {
    const [before] = await db
      .select()
      .from(userSurfaceVisits)
      .where(eq(userSurfaceVisits.userId, userAId));
    const firstVisitedAtBefore = before.firstVisitedAt.getTime();

    // Ensure the clock can actually move between the two writes.
    await new Promise((r) => setTimeout(r, 10));
    await recordSurfaceVisit(userAId, "panorama");

    const [after] = await db
      .select()
      .from(userSurfaceVisits)
      .where(eq(userSurfaceVisits.userId, userAId));
    expect(after.firstVisitedAt.getTime()).toBe(firstVisitedAtBefore);
    expect(after.lastSeenAt.getTime()).toBeGreaterThanOrEqual(before.lastSeenAt.getTime());
  });
});

describe("hasVisitedSurfaces — no cross-talk between surfaces", () => {
  it("visiting panorama does not mark casos, cola or gob_home as visited", async () => {
    // userA has visited "panorama" only, from the block above.
    const visited = await hasVisitedSurfaces(userAId, ["gob_home", "panorama", "casos", "cola"]);
    expect(visited.has("panorama")).toBe(true);
    expect(visited.has("casos")).toBe(false);
    expect(visited.has("cola")).toBe(false);
    expect(visited.has("gob_home")).toBe(false);
  });

  it("recording a second surface adds it without disturbing the first", async () => {
    await recordSurfaceVisit(userAId, "casos");
    const visited = await hasVisitedSurfaces(userAId, ["gob_home", "panorama", "casos", "cola"]);
    expect(visited.has("panorama")).toBe(true);
    expect(visited.has("casos")).toBe(true);
    expect(visited.has("cola")).toBe(false);
    expect(visited.has("gob_home")).toBe(false);
  });

  it("recording the 'cola' surface (the approvals onboarding step) adds it without disturbing the others", async () => {
    await recordSurfaceVisit(userAId, "cola");
    const visited = await hasVisitedSurfaces(userAId, ["gob_home", "panorama", "casos", "cola"]);
    expect(visited.has("panorama")).toBe(true);
    expect(visited.has("casos")).toBe(true);
    expect(visited.has("cola")).toBe(true);
    expect(visited.has("gob_home")).toBe(false);
  });
});

describe("hasVisitedSurfaces — isolation between users", () => {
  it("user A's recorded visits are invisible to user B", async () => {
    // userA has visited panorama + casos + cola (above); userB has visited nothing.
    const visitedB = await hasVisitedSurfaces(userBId, ["gob_home", "panorama", "casos", "cola"]);
    expect(visitedB.size).toBe(0);
  });

  it("recording a visit for user B does not affect user A's state", async () => {
    await recordSurfaceVisit(userBId, "gob_home");
    const visitedA = await hasVisitedSurfaces(userAId, ["gob_home", "panorama", "casos", "cola"]);
    const visitedB = await hasVisitedSurfaces(userBId, ["gob_home", "panorama", "casos", "cola"]);
    expect(visitedA.has("gob_home")).toBe(false);
    expect(visitedB.has("gob_home")).toBe(true);
  });
});
