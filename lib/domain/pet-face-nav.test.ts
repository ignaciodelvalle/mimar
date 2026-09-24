import { describe, expect, it } from "vitest";
import { buildFromLostRedirectTarget, resolvePetFace } from "./pet-face-nav";

// pet-document-redesign ADR-10 (2026-07-02): the Libreta face collapsed to a
// single consolidated timeline — no more lens toggle. `resolvePetFace`'s job
// narrows to "which face does this legacy URL land on", and `lens` becomes a
// fixed value per role (owner: "todo", org: "oficial") regardless of the
// `?lente=` value. This suite keeps every original face-resolution case
// (still 16 assertions below, same names/coverage as the pre-collapse
// baseline) AND extends it with an explicit "the lente value collapse" block
// proving `lente` no longer changes the outcome — see ruling: never weaken.
describe("resolvePetFace", () => {
  const cases: Array<{
    name: string;
    tab: string | undefined;
    lente: string | undefined;
    isOwner: boolean;
    expected: { face: "credencial" | "libreta"; lens: "todo" | "oficial" };
  }> = [
    {
      name: "no tab param — default to Credencial",
      tab: undefined,
      lente: undefined,
      isOwner: true,
      expected: { face: "credencial", lens: "todo" },
    },
    {
      name: "?tab=credencial",
      tab: "credencial",
      lente: undefined,
      isOwner: true,
      expected: { face: "credencial", lens: "todo" },
    },
    {
      name: "?tab=resumen (legacy default)",
      tab: "resumen",
      lente: undefined,
      isOwner: true,
      expected: { face: "credencial", lens: "todo" },
    },
    {
      name: "?tab=vacunas (owner) — routes to the consolidated Libreta face",
      tab: "vacunas",
      lente: undefined,
      isOwner: true,
      expected: { face: "libreta", lens: "todo" },
    },
    {
      name: "?tab=historial (owner) — routes to the consolidated Libreta face",
      tab: "historial",
      lente: undefined,
      isOwner: true,
      expected: { face: "libreta", lens: "todo" },
    },
    {
      name: "?tab=libreta with no lente (owner)",
      tab: "libreta",
      lente: undefined,
      isOwner: true,
      expected: { face: "libreta", lens: "todo" },
    },
    {
      name: "?tab=libreta&lente=vacunas (owner) — lente no longer selects a filter",
      tab: "libreta",
      lente: "vacunas",
      isOwner: true,
      expected: { face: "libreta", lens: "todo" },
    },
    {
      name: "?tab=libreta&lente=todo (owner)",
      tab: "libreta",
      lente: "todo",
      isOwner: true,
      expected: { face: "libreta", lens: "todo" },
    },
    {
      name: "?tab=libreta&lente=oficial (owner) — role wins over the URL param",
      tab: "libreta",
      lente: "oficial",
      isOwner: true,
      expected: { face: "libreta", lens: "todo" },
    },
    {
      name: "?tab=libreta&lente=oficial (org viewer)",
      tab: "libreta",
      lente: "oficial",
      isOwner: false,
      expected: { face: "libreta", lens: "oficial" },
    },
    {
      name: "org viewer + libreta + lente=todo — role wins, still oficial",
      tab: "libreta",
      lente: "todo",
      isOwner: false,
      expected: { face: "libreta", lens: "oficial" },
    },
    {
      name: "org viewer + historial",
      tab: "historial",
      lente: undefined,
      isOwner: false,
      expected: { face: "libreta", lens: "oficial" },
    },
    {
      name: "org viewer + libreta + no lente",
      tab: "libreta",
      lente: undefined,
      isOwner: false,
      expected: { face: "libreta", lens: "oficial" },
    },
    {
      name: "invalid lente value (owner) — ignored, role wins",
      tab: "libreta",
      lente: "bogus",
      isOwner: true,
      expected: { face: "libreta", lens: "todo" },
    },
    {
      name: "invalid lente value (org viewer) — ignored, role wins",
      tab: "libreta",
      lente: "bogus",
      isOwner: false,
      expected: { face: "libreta", lens: "oficial" },
    },
    {
      name: "unknown tab value falls back to Credencial",
      tab: "bogus-tab",
      lente: undefined,
      isOwner: true,
      expected: { face: "credencial", lens: "todo" },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(resolvePetFace({ tab: c.tab, lente: c.lente, isOwner: c.isOwner })).toEqual(
        c.expected,
      );
    });
  }
});

// Extended coverage (ADR-10 collapse) — proves `lente` is fully inert now:
// every value (valid, invalid, or absent) yields the SAME lens for a given
// tab+role combination. Never weakens the baseline above; adds to it.
describe("resolvePetFace — ?lente= collapse (ADR-10)", () => {
  const lenteValues = [undefined, "todo", "vacunas", "oficial", "anything-else"];

  it("owner: every ?lente= value resolves the same lens for ?tab=libreta", () => {
    for (const lente of lenteValues) {
      expect(resolvePetFace({ tab: "libreta", lente, isOwner: true })).toEqual({
        face: "libreta",
        lens: "todo",
      });
    }
  });

  it("org viewer: every ?lente= value resolves the same lens for ?tab=libreta", () => {
    for (const lente of lenteValues) {
      expect(resolvePetFace({ tab: "libreta", lente, isOwner: false })).toEqual({
        face: "libreta",
        lens: "oficial",
      });
    }
  });

  it("?tab=vacunas and ?tab=historial resolve identically to ?tab=libreta (all three collapse to one face)", () => {
    const owner = resolvePetFace({ tab: "libreta", lente: undefined, isOwner: true });
    expect(resolvePetFace({ tab: "vacunas", lente: undefined, isOwner: true })).toEqual(owner);
    expect(resolvePetFace({ tab: "historial", lente: undefined, isOwner: true })).toEqual(owner);
  });
});

// pet-document-redesign REQ-6.3: `?fromLost=1` becomes a no-op redirect —
// the D9 LostCockpit bypass has no target since the cockpit was deleted.
describe("buildFromLostRedirectTarget", () => {
  it("returns null when fromLost is absent (no redirect)", () => {
    expect(buildFromLostRedirectTarget("abc123", {})).toBeNull();
    expect(buildFromLostRedirectTarget("abc123", { tab: "vacunas" })).toBeNull();
  });

  it("strips fromLost and redirects to the plain profile URL when it's the only param", () => {
    expect(buildFromLostRedirectTarget("abc123", { fromLost: "1" })).toBe("/mis-mascotas/abc123");
  });

  it("preserves every other param (e.g. legacy ?tab= deep links keep working)", () => {
    const target = buildFromLostRedirectTarget("abc123", { fromLost: "1", tab: "vacunas" });
    expect(target).toBe("/mis-mascotas/abc123?tab=vacunas");
  });

  it("no dead param retained — fromLost never appears in the redirect target", () => {
    const target = buildFromLostRedirectTarget("abc123", {
      fromLost: "1",
      tab: "libreta",
      lente: "oficial",
    });
    expect(target).not.toContain("fromLost");
    expect(target).toContain("tab=libreta");
    expect(target).toContain("lente=oficial");
  });
});
