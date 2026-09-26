import { describe, expect, it } from "vitest";

import { type HolderEvent, replayPetHolders } from "../lib/projections/pet-holders";
import { type StorylineEvent, normalizeStorylineHolderEvents } from "./seed-storyline-holders";
import { DANGEROUS_STORYLINES } from "./seed-storylines-dangerous";
import { STORYLINES as ICONIC_STORYLINES } from "./seed-storylines-iconic";
import { LEGEND_STORYLINES } from "./seed-storylines-legends";
import { ORIGINAL_10_STORYLINES } from "./seed-storylines-original10";
import { SUPPORTING_STORYLINES } from "./seed-storylines-supporting";

// Every demo storyline, normalized and replayed through the SAME projection the
// holder drift fence uses, must leave its resolved owner holding the pet and
// nobody else (a foster aside). scripts/seed-demo.ts refuses a storyline that
// does not; this test finds it before a reseed does.
//
// Account ids are stand-ins (the keys themselves). The owner and author
// resolution below mirrors scripts/seed-demo.ts (resolveOwnerForStoryline,
// pickAuthorFromRole), which runs main() on import and cannot be imported.

const USERS = ["ignacio", "noeli", "graciela", "lilian", "alejo", "lucas", "admin"];
const ORGS = ["patitas-del-norte", "mascotas-ba-centro", "rescate-puerto-madero"];
const KNOWN = new Set([...USERS, ...ORGS]);

type Story = {
  pet: { public_token: string; owner?: string };
  events: StorylineEvent[];
};

const ALL: Story[] = [
  ...(DANGEROUS_STORYLINES as unknown as Story[]),
  ...(ICONIC_STORYLINES as unknown as Story[]),
  ...(LEGEND_STORYLINES as unknown as Story[]),
  ...(ORIGINAL_10_STORYLINES as unknown as Story[]),
  ...(SUPPORTING_STORYLINES as unknown as Story[]),
];

const TOKEN_OWNERS: Array<[string, { user?: string; org?: string }]> = [
  ["DIM-LAIK", { user: "ignacio" }],
  ["DIM-HACH", { user: "ignacio" }],
  ["DIM-HCN2", { user: "ignacio" }],
  ["DIM-PAL2", { user: "ignacio" }],
  ["DIM-TRRY", { user: "ignacio" }],
  ["DIM-KABO", { user: "noeli" }],
  ["DIM-HNKO", { user: "noeli" }],
  ["DIM-BOBB", { user: "graciela" }],
  ["DIM-FRID", { org: "mascotas-ba-centro" }],
  ["DIM-OWNY", { org: "rescate-puerto-madero" }],
];

function resolveOwner(pet: Story["pet"]): { user?: string; org?: string } {
  if (typeof pet.owner === "string") {
    return pet.owner.startsWith("org:") ? { org: pet.owner.slice(4) } : { user: pet.owner };
  }
  return (
    TOKEN_OWNERS.find(([prefix]) => pet.public_token.startsWith(prefix))?.[1] ?? {
      user: "ignacio",
    }
  );
}

function authorOf(role: string | undefined, ownerUser: string | null): string | null {
  switch (role) {
    case "vet":
      return "lilian";
    case "govt":
      return "lucas";
    case "admin":
      return "admin";
    case "system":
      return null;
    case "shelter":
      return "alejo";
    default:
      return ownerUser ?? "alejo";
  }
}

function replayStory(story: Story) {
  const owner = resolveOwner(story.pet);
  const events = normalizeStorylineHolderEvents(story.events, {
    ownerUserId: owner.user ?? null,
    ownerOrgId: owner.org ?? null,
    fallbackUserId: "alejo",
    fallbackOrgId: "patitas-del-norte",
    isKnownId: (id) => KNOWN.has(id),
  });
  const holderEvents: HolderEvent[] = events.map((e, i) => {
    const authorOrg =
      e.authorOrganizationId ??
      ((e.author_role === "shelter" || e.author_role === "owner") && owner.org ? owner.org : null);
    return {
      id: `e${String(i).padStart(4, "0")}`,
      eventType: e.event_type,
      occurredAt: new Date(`${e.date}T12:00:00Z`),
      // The loader inserts one statement per event, so recorded_at follows
      // the array order.
      recordedAt: new Date(Date.UTC(2026, 0, 1) + i),
      payload: e.payload ?? {},
      recordedByUserId: authorOf(e.author_role, owner.user ?? null),
      authorOrganizationId: authorOrg,
      authorRole: e.author_role ?? "system",
    } as HolderEvent;
  });
  return { owner, events, intervals: replayPetHolders(holderEvents) };
}

describe("normalizeStorylineHolderEvents over every demo storyline", () => {
  it("covers the storylines (non-vacuity)", () => {
    expect(ALL.length).toBeGreaterThanOrEqual(39);
  });

  for (const story of ALL) {
    it(`${story.pet.public_token} ends held by its resolved owner only`, () => {
      const { owner, intervals } = replayStory(story);
      const subject = owner.org ? `org:${owner.org}` : `user:${owner.user}`;
      const live = intervals.filter((i) => i.endedAt === null);
      expect(
        live.some((i) => i.subject === subject && (owner.org !== undefined || i.role === "owner")),
      ).toBe(true);
      expect(live.filter((i) => i.subject !== subject && i.role !== "foster")).toEqual([]);
      // Every holder the replay names is a seeded account.
      for (const i of intervals) expect(KNOWN.has(i.subject.split(":")[1])).toBe(true);
    });
  }
});

describe("normalizeStorylineHolderEvents rules", () => {
  const ctx = {
    ownerUserId: "ignacio",
    ownerOrgId: null,
    fallbackUserId: "alejo",
    fallbackOrgId: "patitas-del-norte",
    isKnownId: (id: string) => KNOWN.has(id),
  };

  it("R1: replaces an off-platform party with the owner", () => {
    const [e] = normalizeStorylineHolderEvents(
      [
        {
          date: "2020-01-01",
          event_type: "custody_transferred",
          payload: { from_user_id: "ignacio", to_user_id: "H. Ueno" },
        },
      ],
      ctx,
    );
    expect(e.payload).toMatchObject({ from_user_id: "ignacio", to_user_id: "ignacio" });
  });

  it("R5: a registration after a shelter intake becomes an adoption out of it", () => {
    const out = normalizeStorylineHolderEvents(
      [
        { date: "2020-01-01", event_type: "shelter_intake_recorded", author_role: "shelter" },
        { date: "2020-02-01", event_type: "pet_registered", author_role: "owner" },
      ],
      ctx,
    );
    expect(out.map((e) => e.event_type)).toEqual([
      "shelter_intake_recorded",
      "pet_registered",
      "adoption_finalized",
    ]);
    expect(out[2]).toMatchObject({ synthesized: true, date: "2020-02-01" });
    expect(out[0].authorOrganizationId).toBe("patitas-del-norte");
  });

  it("R3: an org-held registration is authored by the org as shelter custody", () => {
    const [e] = normalizeStorylineHolderEvents(
      [{ date: "2020-01-01", event_type: "pet_registered", author_role: "owner", payload: {} }],
      { ...ctx, ownerUserId: null, ownerOrgId: "patitas-del-norte" },
    );
    expect(e.authorOrganizationId).toBe("patitas-del-norte");
    expect(e.payload).toMatchObject({ custody_kind: "shelter_custody_by_org" });
  });
});
