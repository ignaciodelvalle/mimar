// isPetAdoptedByUser (QA A9) — the shared predicate that gates BOTH the
// "Check-in post-adopción" catalog entry (anotar surfaces) and the check-in
// page's 404. Locks:
//   - no adoption_finalized event → false;
//   - latest adoption names the user as adopter → true;
//   - latest adoption names someone else → false (no leak into the catalog);
//   - payload without adopter_user_id → false.

import { beforeEach, describe, expect, it, vi } from "vitest";

// Chainable @/db stub (see gob-pet-subview.test.ts). Only `db` is replaced —
// the real table exports (drizzle refs, no DB connection at import) stay.
const h = vi.hoisted(() => {
  const dbState = { queue: [] as unknown[] };
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "from", "where", "limit", "orderBy", "innerJoin", "leftJoin"]) {
    builder[m] = () => builder;
  }
  // biome-ignore lint/suspicious/noThenProperty: intentional thenable query-builder stub for the @/db mock
  (builder as { then: unknown }).then = (
    resolve: (v: unknown) => unknown,
    reject: (e: unknown) => unknown,
  ) => Promise.resolve(dbState.queue.length ? dbState.queue.shift() : []).then(resolve, reject);
  return { dbState, builder };
});

vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, db: h.builder };
});

import {
  findLatestAdoption,
  findOpenPostAdoptionCheckinReminder,
  isPetAdoptedByUser,
} from "../adoption-checkin";

beforeEach(() => {
  vi.clearAllMocks();
  h.dbState.queue = [];
});

describe("isPetAdoptedByUser", () => {
  it("returns false when the pet has no adoption_finalized event", async () => {
    h.dbState.queue = [[]];
    expect(await isPetAdoptedByUser("pet-1", "user-1")).toBe(false);
  });

  it("returns true when the latest adoption names the user as adopter", async () => {
    h.dbState.queue = [[{ payload: { adopter_user_id: "user-1" } }]];
    expect(await isPetAdoptedByUser("pet-1", "user-1")).toBe(true);
  });

  it("returns false when the latest adoption names a DIFFERENT adopter", async () => {
    h.dbState.queue = [[{ payload: { adopter_user_id: "someone-else" } }]];
    expect(await isPetAdoptedByUser("pet-1", "user-1")).toBe(false);
  });

  it("returns false when the adoption payload carries no adopter_user_id", async () => {
    h.dbState.queue = [[{ payload: {} }]];
    expect(await isPetAdoptedByUser("pet-1", "user-1")).toBe(false);
  });
});

describe("findLatestAdoption — the one lookup the predicate, the writer and the endpoint share", () => {
  it("hands back BOTH halves of the adoption: who adopted, and from whom", async () => {
    // The check-in writer needs the organization as well as the adopter — the
    // refugio the check-in is addressed to — which is why this is a function
    // of its own and not folded into the boolean above.
    h.dbState.queue = [
      [{ payload: { adopter_user_id: "user-1", previous_owner_organization_id: "org-9" } }],
    ];
    expect(await findLatestAdoption("pet-1")).toEqual({
      adopterUserId: "user-1",
      organizationId: "org-9",
    });
  });

  it("answers null for an animal never adopted through the platform", async () => {
    h.dbState.queue = [[]];
    expect(await findLatestAdoption("pet-1")).toBeNull();
  });
});

describe("findOpenPostAdoptionCheckinReminder — the window the page, the writer and the endpoint agree on", () => {
  it("returns the soonest open window", async () => {
    const dueAt = new Date("2026-10-01T12:00:00Z");
    h.dbState.queue = [[{ id: "rem-1", dueAt }]];
    expect(await findOpenPostAdoptionCheckinReminder("pet-1", "user-1")).toEqual({
      id: "rem-1",
      dueAt,
    });
  });

  it("returns null when nothing is pending — a fact, not an empty list", async () => {
    h.dbState.queue = [[]];
    expect(await findOpenPostAdoptionCheckinReminder("pet-1", "user-1")).toBeNull();
  });
});
