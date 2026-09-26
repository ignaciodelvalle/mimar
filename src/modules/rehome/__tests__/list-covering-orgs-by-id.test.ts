// The rehome picker's list by catalogue id (localidades-por-id D5). When the
// repository reports the `coverage` flag on the id path, an org whose zone
// recorded Bragado's Mechita is not offered for a pet in Alberti's Mechita.
// Without a mode (the default) the list is the name path, unchanged.

import { describe, expect, it } from "vitest";

import { listCoveringOrgs } from "../application/list-covering-orgs";

const row = (id: string, localityId: string | null) => ({
  id,
  publicToken: `tok-${id}`,
  displayName: `Org ${id}`,
  orgType: "shelter",
  coverage: { jurisdictionProvince: "Buenos Aires", jurisdictionLocality: "Mechita", localityId },
});

const zone = { province: "Buenos Aires", locality: "Mechita", localityId: "loc-alberti" };

function repo(mode?: "name" | "id") {
  return {
    findSponsorCandidatesInProvince: async () => [
      row("bragado", "loc-bragado"),
      row("alberti", "loc-alberti"),
    ],
    ...(mode ? { coverageMode: async () => mode } : {}),
  };
}

describe("listCoveringOrgs — coverage mode (D5)", () => {
  it("on the id path offers only the org whose zone is the pet's row", async () => {
    const orgs = await listCoveringOrgs(zone, { repo: repo("id") });
    expect(orgs.map((o) => o.id)).toEqual(["alberti"]);
  });

  it("on the name path (default) offers both, as before", async () => {
    expect((await listCoveringOrgs(zone, { repo: repo() })).map((o) => o.id)).toEqual([
      "bragado",
      "alberti",
    ]);
    expect((await listCoveringOrgs(zone, { repo: repo("name") })).map((o) => o.id)).toHaveLength(2);
  });
});
