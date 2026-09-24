import { describe, expect, it } from "vitest";
import { redactSmallSubregionCells, redactSubregionAggregate } from "./subregion-redaction";

describe("redactSmallSubregionCells (k-anon, k=5)", () => {
  it("redacts counts 1..4 to 0 and marks them suppressed", () => {
    const rows = [
      { code: "06007", name: "Adolfo Alsina", count: 1 },
      { code: "06014", name: "Adolfo Gonzales Chaves", count: 4 },
    ];
    const out = redactSmallSubregionCells(rows);
    for (const r of out) {
      expect(r.suppressed).toBe(true);
      expect(r.count).toBe(0);
    }
  });

  it("passes counts >= 5 through untouched", () => {
    const out = redactSmallSubregionCells([{ code: "06021", name: "Alberti", count: 5 }]);
    expect(out).toEqual([{ code: "06021", name: "Alberti", count: 5 }]);
  });

  it("keeps zero-count rows visible as zero (no cases ≠ suppressed)", () => {
    const out = redactSmallSubregionCells([{ code: "06028", name: "Almirante Brown", count: 0 }]);
    expect(out).toEqual([{ code: "06028", name: "Almirante Brown", count: 0 }]);
    expect(out[0].suppressed).toBeUndefined();
  });

  it("mixed set: only the 1..4 band is redacted by the PRIMARY pass", () => {
    // Two in-band cells (b, d) keep the complementary pass a no-op here (it only
    // engages a group with EXACTLY one primary-suppressed cell — see the
    // "complementary suppression" describe block below for that scenario in
    // isolation) — so this test stays a clean check of the primary k-anon band.
    const out = redactSmallSubregionCells([
      { code: "a", name: "A", count: 0 },
      { code: "b", name: "B", count: 3 },
      { code: "d", name: "D", count: 2 },
      { code: "c", name: "C", count: 12 },
    ]);
    expect(out.find((r) => r.code === "a")).toEqual({ code: "a", name: "A", count: 0 });
    expect(out.find((r) => r.code === "b")).toMatchObject({ count: 0, suppressed: true });
    expect(out.find((r) => r.code === "d")).toMatchObject({ count: 0, suppressed: true });
    expect(out.find((r) => r.code === "c")).toEqual({ code: "c", name: "C", count: 12 });
  });

  it("never returns a row with 0 < count < 5", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      code: `c${i}`,
      name: `C${i}`,
      count: i,
    }));
    const out = redactSmallSubregionCells(rows);
    for (const r of out) {
      expect(r.count === 0 || r.count >= 5).toBe(true);
    }
  });

  describe("complementary suppression (differencing-attack defense)", () => {
    it("a lone k<5-suppressed cell also suppresses its smallest visible sibling, so the hidden value can't be recovered by subtraction against a published province total", () => {
      const rows = [
        { code: "a", name: "A", count: 2 }, // primary-suppressed (k=5)
        { code: "b", name: "B", count: 10 }, // smallest visible sibling — must become the complement
        { code: "c", name: "C", count: 20 }, // stays visible
      ];
      const out = redactSmallSubregionCells(rows);

      const a = out.find((r) => r.code === "a")!;
      const b = out.find((r) => r.code === "b")!;
      const c = out.find((r) => r.code === "c")!;

      // Both "a" (primary) and "b" (complement) are suppressed — a would-be
      // attacker can no longer isolate "a"'s hidden count via
      // `total − (b + c)`, since b is withheld too.
      expect(a).toMatchObject({ count: 0, suppressed: true });
      expect(b).toMatchObject({ count: 0, suppressed: true });
      // The untouched sibling stays visible with its real value — proof this
      // pass only ADDS suppression, it never reveals or un-suppresses.
      expect(c).toEqual({ code: "c", name: "C", count: 20 });
    });

    it("does not complement when zero or two-or-more cells are already suppressed (nothing isolable)", () => {
      const rows = [
        { code: "a", name: "A", count: 1 },
        { code: "b", name: "B", count: 3 },
        { code: "c", name: "C", count: 50 },
      ];
      const out = redactSmallSubregionCells(rows);

      // Both sub-k cells are already suppressed (2 suppressed, not 1) — no
      // differencing attack is possible, so the visible sibling is left alone.
      expect(out.find((r) => r.code === "a")).toMatchObject({ suppressed: true, count: 0 });
      expect(out.find((r) => r.code === "b")).toMatchObject({ suppressed: true, count: 0 });
      expect(out.find((r) => r.code === "c")).toEqual({ code: "c", name: "C", count: 50 });
    });

    it("a single-cell suppressed set has no visible sibling to complement (nothing to promote)", () => {
      const out = redactSmallSubregionCells([{ code: "a", name: "A", count: 2 }]);
      expect(out).toEqual([{ code: "a", name: "A", count: 0, suppressed: true }]);
    });
  });
});

describe("redactSubregionAggregate — the fold's residual rides the same k-anon pass (L1·1)", () => {
  const cells = [
    { code: "06007", name: "Adolfo Alsina", count: 9 },
    { code: "06014", name: "Adolfo Gonzales Chaves", count: 12 },
  ];

  it("publishes a residual at/above k=5 as-is and leaves the cells alone", () => {
    const out = redactSubregionAggregate(cells, 7);
    expect(out.sinUbicacion).toEqual({ count: 7, suppressed: false });
    expect(out.cells).toEqual(cells);
  });

  it("never returns the residual as a cell", () => {
    const out = redactSubregionAggregate(cells, 7);
    expect(out.cells.map((c) => c.code)).toEqual(["06007", "06014"]);
  });

  it("redacts a residual of 1..4 and complementarily suppresses the smallest visible cell", () => {
    const out = redactSubregionAggregate(cells, 2);
    expect(out.sinUbicacion).toEqual({ count: 0, suppressed: true });
    expect(out.cells.find((c) => c.code === "06007")).toMatchObject({ count: 0, suppressed: true });
    expect(out.cells.find((c) => c.code === "06014")).toMatchObject({ count: 12 });
  });

  it("a zero residual is an honest zero, not suppressed", () => {
    expect(redactSubregionAggregate(cells, 0).sinUbicacion).toEqual({
      count: 0,
      suppressed: false,
    });
  });
});
