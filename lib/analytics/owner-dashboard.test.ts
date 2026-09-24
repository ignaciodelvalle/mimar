// Smoke tests for the owner dashboard data layer.
//
// These hit the real local Supabase DB (same posture as the other
// integration tests in this repo). They assert the shape of the
// returned data, not specific rows — so they keep passing as the seed
// changes. The functions must NOT throw for an unknown user (return
// empty arrays).

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  countUnreadNotifications,
  fetchLivingPetLocalities,
  fetchOngoingMedications,
  fetchOpenWorkflows,
  fetchPetsForOwner,
  fetchPreviousWorkflows,
  fetchUnreadNotifications,
  fetchUpcomingAppointments,
} from "@/lib/analytics/owner-dashboard";

const RANDOM_USER_ID = "00000000-0000-0000-0000-000000000000";

beforeAll(() => {
  // No setup — these queries are read-only.
});

afterAll(() => {
  // No teardown.
});

describe("owner-dashboard — empty user", () => {
  it("returns empty arrays for a user that owns nothing", async () => {
    const [petsResult, appts, notifs, unreadCount, meds, open, prev, locs] = await Promise.all([
      fetchPetsForOwner(RANDOM_USER_ID),
      fetchUpcomingAppointments(RANDOM_USER_ID),
      fetchUnreadNotifications(RANDOM_USER_ID),
      countUnreadNotifications(RANDOM_USER_ID),
      fetchOngoingMedications(RANDOM_USER_ID),
      fetchOpenWorkflows(RANDOM_USER_ID),
      fetchPreviousWorkflows(RANDOM_USER_ID),
      fetchLivingPetLocalities(RANDOM_USER_ID),
    ]);
    // fetchPetsForOwner now returns { pets, total } — both should be empty/zero.
    expect(petsResult.pets).toEqual([]);
    expect(petsResult.total).toBe(0);
    expect(appts).toEqual([]);
    expect(notifs).toEqual([]);
    expect(unreadCount).toBe(0);
    expect(meds).toEqual([]);
    expect(open).toEqual([]);
    expect(prev).toEqual([]);
    expect(locs).toEqual([]);
  });
});
