import { describe, expect, it } from "vitest";

import { getPriorityBadge, isTransitRole } from "./PetCard.helpers";

describe("getPriorityBadge — PetCard priority logic", () => {
  it("status='lost' wins over any vaccine variant", () => {
    expect(getPriorityBadge("lost", { variant: "overdue_critical" })).toEqual({ kind: "lost" });
    expect(getPriorityBadge("lost", { variant: "upcoming" })).toEqual({ kind: "lost" });
    expect(getPriorityBadge("lost", undefined)).toEqual({ kind: "lost" });
  });

  it("status='deceased' wins over any vaccine variant", () => {
    expect(getPriorityBadge("deceased", { variant: "overdue_critical" })).toEqual({
      kind: "deceased",
    });
    expect(getPriorityBadge("deceased", undefined)).toEqual({ kind: "deceased" });
  });

  it("status='active' falls through to vaccine variant when present", () => {
    expect(getPriorityBadge("active", { variant: "overdue_critical" })).toEqual({
      kind: "vaccine",
      variant: "overdue_critical",
    });
    expect(getPriorityBadge("active", { variant: "due_soon" })).toEqual({
      kind: "vaccine",
      variant: "due_soon",
    });
  });

  it("status='active' with no vaccine state returns none", () => {
    expect(getPriorityBadge("active", undefined)).toEqual({ kind: "none" });
  });

  it("unknown variants are ignored (returns none for active)", () => {
    // success variant: doesn't warrant a chip
    expect(getPriorityBadge("active", { variant: "success" as never })).toEqual({ kind: "none" });
  });
});

describe("isTransitRole — 'En tránsito' badge predicate (AF-H2 / foster-alta-2026-07-21)", () => {
  it("fires for an org-linked foster placement", () => {
    // A fostered pet joins on ownerUserId=user.id with role='foster'.
    expect(isTransitRole("foster")).toBe(true);
  });

  it("does not fire for an owner", () => {
    expect(isTransitRole("owner")).toBe(false);
  });

  it("fires for shelter_custody (vecino-helps-stray, no org involved)", () => {
    // AGENTS.md "Shelter custody is temporary by definition": a citizen who
    // picks up a stray (or self-declares custody via the alta's
    // CustodyKindToggle "la estoy cuidando") gets ownerUserId set +
    // role='shelter_custody', with no org link. Both "Mis mascotas" and the
    // pet profile page scope their ownership query to ownerUserId=user.id, so
    // a shelter_custody row reaching this predicate is guaranteed to be this
    // vecino case — an org-held shelter_custody row has ownerUserId=null and
    // never joins into a user-scoped query. (2026-07-21: restored after AF-H2
    // had narrowed this to foster-only under the false assumption that
    // shelter_custody is always org-level, which silently made the alta's
    // "la estoy cuidando" registration invisible as "En tránsito".)
    expect(isTransitRole("shelter_custody")).toBe(true);
  });
});
