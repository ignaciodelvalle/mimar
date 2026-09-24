import { describe, expect, it } from "vitest";

import type { LnPetStatus } from "@/components/ui/Chip";
import { petUrgencyRank } from "./pet-urgency-rank";

describe("petUrgencyRank", () => {
  it("orders statuses most-urgent-first: lost < sick < pregnant < registered < ok", () => {
    const order: LnPetStatus[] = ["lost", "sick", "pregnant", "registered", "ok"];
    const ranks = order.map(petUrgencyRank);
    // Strictly ascending — each bucket sorts before the next.
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeGreaterThan(ranks[i - 1]);
    }
  });

  it("ranks 'lost' first (0) and 'ok' last of the known buckets (4)", () => {
    expect(petUrgencyRank("lost")).toBe(0);
    expect(petUrgencyRank("ok")).toBe(4);
  });

  it("sorts a mixed list urgent-first", () => {
    const pets: Array<{ name: string; status: LnPetStatus }> = [
      { name: "al-dia", status: "ok" },
      { name: "perdida", status: "lost" },
      { name: "por-vencer", status: "registered" },
      { name: "preñada", status: "pregnant" },
    ];
    const sorted = [...pets].sort((a, b) => petUrgencyRank(a.status) - petUrgencyRank(b.status));
    expect(sorted.map((p) => p.name)).toEqual(["perdida", "preñada", "por-vencer", "al-dia"]);
  });
});
