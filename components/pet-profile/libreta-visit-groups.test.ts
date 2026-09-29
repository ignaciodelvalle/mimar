// groupPastByVisit — one atención reads as one block (vet-visit-record).

import { describe, expect, it } from "vitest";

import { groupPastByVisit, visitHeader } from "./libreta-visit-groups";

const row = (id: string, day: number, visitId: string | null = null) => ({
  id,
  occurredAt: new Date(Date.UTC(2026, 8, day, 15)),
  visitId,
});

describe("groupPastByVisit", () => {
  it("leaves records without a visit exactly as they were", () => {
    const rows = [row("a", 20), row("b", 19)];
    expect(groupPastByVisit(rows)).toEqual([
      { kind: "event", row: rows[0] },
      { kind: "event", row: rows[1] },
    ]);
  });

  it("gathers a visit's records where its newest one was, keeping their order", () => {
    // Newest first, and an unrelated record interleaved between two of the
    // visit's own — it stays outside the block, after it.
    const rows = [row("v1", 21, "V"), row("x", 21), row("v2", 20, "V"), row("y", 18)];
    const entries = groupPastByVisit(rows, {
      V: { modality: "home", openedAt: new Date(Date.UTC(2026, 8, 20, 14)) },
    });
    expect(
      entries.map((e) => (e.kind === "event" ? e.row.id : `[${e.rows.map((r) => r.id)}]`)),
    ).toEqual(["[v1,v2]", "x", "y"]);
    const block = entries[0];
    if (block.kind !== "visit") throw new Error("expected a visit block");
    expect(block.header).toMatch(/^Atención · .+ · A domicilio$/);
  });

  it("keeps two visits apart", () => {
    const entries = groupPastByVisit([row("a", 22, "V2"), row("b", 20, "V1")]);
    expect(entries.map((e) => e.kind === "visit" && e.visitId)).toEqual(["V2", "V1"]);
  });
});

describe("visitHeader", () => {
  it("omits the modality when the visit is unknown to the caller", () => {
    expect(visitHeader(undefined, new Date(Date.UTC(2026, 8, 20, 15)))).toMatch(
      /^Atención · [^·]+$/,
    );
  });

  it("never prints a raw modality code", () => {
    expect(visitHeader({ modality: "moon", openedAt: new Date() }, new Date())).not.toContain(
      "moon",
    );
  });
});
