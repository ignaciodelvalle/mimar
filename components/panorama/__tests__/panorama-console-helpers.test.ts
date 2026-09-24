import { describe, expect, it } from "vitest";

import {
  activeSuppressedCells,
  buildViewMeta,
  calendarEmptyMessage,
  initialState,
  parseLayersParam,
  unknownLayerIds,
} from "@/components/panorama/panorama-console-helpers";
import { parseAsOfFromParams } from "@/lib/ui/map-layer-nav";
import { formatAsOfDayLong } from "@/src/modules/panorama/domain/time-scrub";

/**
 * `?layers=` fidelity.
 *
 * parseLayersParam DROPS ids it cannot resolve — correct for rendering (an
 * unknown id cannot be drawn) but silent, which is wrong under Panorama's
 * "compartir vista" identity: a link written before a layer was renamed reopens
 * with a smaller board and no hint that anything was lost, so the operator
 * reads a complete-looking view that is not the one they were sent.
 *
 * `unknownLayerIds` is the other half — what was lost, so the console can say so.
 */
describe("unknownLayerIds", () => {
  it("names the ids a shared link asked for that no longer exist", () => {
    expect(unknownLayerIds("zoonosis,brotes_zoonosis,mordeduras")).toEqual(["brotes_zoonosis"]);
  });

  it("says nothing when every id resolves", () => {
    expect(unknownLayerIds("zoonosis,mordeduras")).toEqual([]);
  });

  it("says nothing for an absent or empty param", () => {
    expect(unknownLayerIds(null)).toEqual([]);
    expect(unknownLayerIds("")).toEqual([]);
  });

  it("agrees with parseLayersParam — what one drops is what the other names", () => {
    // The two must partition the input; a gap between them is how a layer goes
    // missing with nobody reporting it.
    const raw = "zoonosis,nope,mordeduras,tampoco";
    expect(parseLayersParam(raw)).toEqual(["zoonosis", "mordeduras"]);
    expect(unknownLayerIds(raw)).toEqual(["nope", "tampoco"]);
  });
});

// P1-F4 (external design review): two clocks on one screen. The view card said
// "Estado actual" — it has the rule — while the dock stamped "últimos 90 días"
// over the same numbers, and the most quotable figure on the console (the
// Registros badge) sat next to the wrong one. The dock also never declared the
// asOf cut at all.
describe("buildViewMeta — one clock, and it declares the as-of cut", () => {
  const SINCE = new Date("2026-04-01T00:00:00Z");
  const UNTIL = new Date("2026-06-30T00:00:00Z");

  function statesWith(active: string[]) {
    const states = initialState();
    for (const id of active) {
      const s = states[id as keyof typeof states];
      if (s) states[id as keyof typeof states] = { ...s, active: true };
    }
    return states;
  }

  it("says 'estado actual' when every active layer is current-state", () => {
    // microchip is a current-state layer (temporal: false).
    const meta = buildViewMeta({
      province: null,
      locality: null,
      since: SINCE,
      until: UNTIL,
      periodParam: "90d",
      states: statesWith(["microchip"]),
      asOf: null,
    });
    expect(meta.periodLabel).toBe("estado actual");
  });

  it("keeps the period when at least one active layer is temporal", () => {
    const meta = buildViewMeta({
      province: null,
      locality: null,
      since: SINCE,
      until: UNTIL,
      periodParam: "90d",
      // desierto-veterinario is the temporal one here; mortalidad is
      // current-state despite the intuition (layers.ts declares it temporal:false).
      states: statesWith(["microchip", "desierto-veterinario"]),
      asOf: null,
    });
    expect(meta.periodLabel).not.toBe("estado actual");
  });

  it("appends the as-of cut when one is active", () => {
    const meta = buildViewMeta({
      province: null,
      locality: null,
      since: SINCE,
      until: UNTIL,
      periodParam: "90d",
      states: statesWith(["desierto-veterinario"]),
      asOf: new Date("2026-05-15T00:00:00Z"),
    });
    expect(meta.periodLabel).toContain("· al ");
  });

  it("declares the as-of cut even on a current-state view", () => {
    const meta = buildViewMeta({
      province: null,
      locality: null,
      since: SINCE,
      until: UNTIL,
      periodParam: "90d",
      states: statesWith(["microchip"]),
      asOf: new Date("2026-05-15T00:00:00Z"),
    });
    expect(meta.periodLabel).toContain("estado actual");
    expect(meta.periodLabel).toContain("· al ");
  });

  // T2.4 cross-surface same-day fence: one URL, one calendar day, everywhere.
  // Browser-verified defect: ?asOf=2026-05-08 → the dock said "08 may" while
  // this label said "al 7 de mayo" (AR-timezone formatter over a UTC day
  // marker). Both the URL decode and the label are exercised end-to-end here.
  it("renders the URL's calendar day — never the previous one (URL 2026-05-08 → al 8 de mayo)", () => {
    const asOf = parseAsOfFromParams(new URLSearchParams("asOf=2026-05-08"));
    expect(asOf).not.toBeNull();
    const meta = buildViewMeta({
      province: null,
      locality: null,
      since: SINCE,
      until: UNTIL,
      periodParam: "90d",
      states: statesWith(["desierto-veterinario"]),
      asOf,
    });
    expect(meta.periodLabel).toContain("al 8 de mayo de 2026");
    // And the label is literally the shared formatter's output — the dock
    // headline and export footer read the same function, so the surfaces
    // cannot disagree by construction.
    expect(meta.periodLabel.endsWith(`al ${formatAsOfDayLong(asOf as Date)}`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RA-7 F6 — ONE answer to "cuántas celdas están protegidas".
//
// The console published four. Two of them ("this view's protected cells") were
// the SAME claim computed twice: the legend pill summed ACTIVE + NON-LOADING
// layers, `buildViewMeta` (→ the exported PNG footer and the printed informe)
// summed ACTIVE layers whether or not they were mid-refetch. So for the whole
// duration of any refetch the two disagreed ON SCREEN, and the artifact the
// operator hands to a funcionario carried the number that included a layer's
// PREVIOUS scope. The other two figures (the Registros caption, the ranking
// line) are legitimately narrower universes and keep their own numbers — they
// now name what they measure at their call sites.
// ---------------------------------------------------------------------------
describe("activeSuppressedCells — the single view-wide k-anon figure", () => {
  function states(
    overrides: Record<string, { active?: boolean; loading?: boolean; suppressedCount?: number }>,
  ) {
    const out = initialState();
    for (const [id, patch] of Object.entries(overrides)) {
      const s = out[id as keyof typeof out];
      if (s) out[id as keyof typeof out] = { ...s, ...patch };
    }
    return out;
  }

  it("sums the ACTIVE layers and keeps the per-layer breakdown", () => {
    const result = activeSuppressedCells(
      states({
        denuncias: { active: true, suppressedCount: 3 },
        mordeduras: { active: true, suppressedCount: 1 },
      }),
    );
    expect(result.total).toBe(4);
    expect(result.breakdown.map((b) => b.value)).toEqual([1, 3]);
  });

  it("ignores INACTIVE layers — a layer not on the board is not part of this view", () => {
    expect(activeSuppressedCells(states({ denuncias: { suppressedCount: 9 } })).total).toBe(0);
  });

  it("ignores LOADING layers — their count still describes the PREVIOUS scope", () => {
    // Attributing a stale count to the scope now on screen is a false claim
    // about privacy, which is the one number that must not be approximated.
    expect(
      activeSuppressedCells(
        states({ denuncias: { active: true, loading: true, suppressedCount: 9 } }),
      ).total,
    ).toBe(0);
  });

  it("is THE figure buildViewMeta publishes — the pill and the PNG footer cannot drift", () => {
    // The regression this exists to prevent: two reduces of one claim. Both
    // surfaces read this function, so agreement is structural, not coincidental.
    const s = states({
      denuncias: { active: true, suppressedCount: 3 },
      mordeduras: { active: true, suppressedCount: 1 },
    });
    expect(
      buildViewMeta({
        province: null,
        locality: null,
        since: new Date("2026-04-01T00:00:00Z"),
        until: new Date("2026-06-30T00:00:00Z"),
        periodParam: "90d",
        states: s,
        asOf: null,
      }).suppressedCount,
    ).toBe(activeSuppressedCells(s).total);
  });

  it("agrees with the pill DURING a refetch — the exact window the two used to disagree in", () => {
    // Before the fix: pill 3 (drops the loading layer), footer 4 (keeps its
    // last-known count). Same board, same instant, two numbers.
    const s = states({
      denuncias: { active: true, suppressedCount: 3 },
      mordeduras: { active: true, loading: true, suppressedCount: 1 },
    });
    expect(activeSuppressedCells(s).total).toBe(3);
    expect(
      buildViewMeta({
        province: null,
        locality: null,
        since: new Date("2026-04-01T00:00:00Z"),
        until: new Date("2026-06-30T00:00:00Z"),
        periodParam: "90d",
        states: s,
        asOf: null,
      }).suppressedCount,
    ).toBe(3);
  });
});

/**
 * The calendar's empty state must not claim a jurisdiction had no events.
 *
 * WHY (fresh-context review, 2026-08-22): 4c8fe3b1 stopped the histogram
 * endpoint from publishing per-day counts and dates for a single-unit scope
 * under ANONYMITY_K, and shipped a DECLARED envelope (`suppressed: true`)
 * precisely so a caller could tell suppression apart from absence. The console
 * then read `body.histogram ?? []`, dropped the flag on the floor, and rendered
 * "Sin eventos registrados en este período y alcance." over the protected
 * window — reinstating, in the UI, the exact false statement the commit set out
 * to remove.
 *
 * The copy reuses the map's existing suppression vocabulary
 * ("protegido por privacidad (k<5)", all-suppressed-notice.tsx) rather than
 * inventing a second phrase for the same treatment.
 */
describe("calendarEmptyMessage — suppression is not absence", () => {
  it("says the window is PROTECTED, never that nothing happened", () => {
    const msg = calendarEmptyMessage({ hasTemporalLayer: true, suppressed: true });
    expect(msg).toContain("protegida por privacidad (k<5)");
    // The false statement must be gone, not merely softened.
    expect(msg).not.toContain("Sin eventos");
  });

  it("still reports a genuine absence when nothing is suppressed", () => {
    const msg = calendarEmptyMessage({ hasTemporalLayer: true, suppressed: false });
    expect(msg).toBe("Sin eventos registrados en este período y alcance.");
  });

  it("asks for a temporal layer before it talks about events at all", () => {
    const msg = calendarEmptyMessage({ hasTemporalLayer: false, suppressed: false });
    expect(msg).toContain("Activá una capa con dimensión temporal");
  });

  it("no temporal layer outranks suppression — there is nothing to protect yet", () => {
    const msg = calendarEmptyMessage({ hasTemporalLayer: false, suppressed: true });
    expect(msg).toContain("Activá una capa con dimensión temporal");
  });
});
