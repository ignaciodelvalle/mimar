// @vitest-environment jsdom
//
// PanoramaConsole — map-QOL fluid board commits (feat/map-qol).
//
// The preset period commit used to be an INTERIM full document navigation
// (`window.location.assign`, commit 0e94f198) to dodge the Next 15.5.x
// router-drop defect. The map-QOL mechanism SUPERSEDES that cure: the board
// (period/layers/level/preset) is committed via the shallow History API
// (lib/ui/map-layer-nav.ts pushMapStateUrl) and the data is refetched with a
// plain client fetch — no router transition exists to be dropped, and no
// reload happens. These tests pin that contract:
//   1. preset click → history.pushState with the full board URL, NO
//      router.push/replace/refresh, NO location.assign;
//   2. the preset's layers are fetched client-side against the NEW params;
//   3. the committed board is persisted to localStorage for the bare-URL
//      restore.
//
// Scope: the onPreset commit path + board persistence. The map and the other
// panels are mocked out — they pull in maplibre-gl and are irrelevant here.
//
// ─── ASYNC BUDGET (file-level, deliberate) ─────────────────────────────────
// This file waits on async settle 59 times (`waitFor`) plus `findBy*`. Every
// one of them used to run on Testing Library's 1000 ms default, and CI ate a
// 1541 ms flake against it — a console whose fetch fan-out (features + KPIs +
// histogram + rule-change markers) legitimately takes longer than a second on
// a cold, contended runner.
//
// The fix is a BUDGET FOR THE FILE, not a per-call patch: WAITFOR_BUDGET_MS is
// installed as Testing Library's `asyncUtilTimeout`, which is the single value
// `waitFor` and `findBy*` both read at call time. So every wait in this file
// inherits it without 59 edits, and a call site that genuinely needs longer
// still passes its own `{ timeout }` (an explicit option always wins).
//
// Note for anyone tempted to "fix" a slow wait elsewhere: Vitest's `testTimeout`
// does NOT reach this — it bounds the TEST, while `waitFor` bounds itself and
// fails first with its own message.
//
// 5000 ms is chosen as ~3× the worst measured settle (1541 ms) on CI-class
// hardware: wide enough that runner contention cannot turn a passing assertion
// red, tight enough that a genuine hang still fails in seconds instead of
// riding the test budget.

import "@testing-library/jest-dom/vitest";

import {
  act,
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Async settle budget for THIS FILE — see the header note. Read by every
 * `waitFor` / `findBy*` below (Testing Library's `asyncUtilTimeout`), so the
 * budget lives in exactly one place instead of 59.
 */
const WAITFOR_BUDGET_MS = 5_000;
configure({ asyncUtilTimeout: WAITFOR_BUDGET_MS });

const routerPush = vi.fn();
const routerReplace = vi.fn();
const routerRefresh = vi.fn();

// PanoramaConsole keys effects on the searchParams OBJECT identity — mirror
// Next's real guarantee (stable reference until the URL actually changes) by
// memoizing on the search string. A fresh instance per call would loop.
let cachedSearchKey: string | null = null;
let cachedSearchParams: URLSearchParams | null = null;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: routerReplace, refresh: routerRefresh }),
  // política → resultado: the console reads the pathname to decide whether the
  // marker card may link out to /admin/inteligencia (admin-only surface).
  usePathname: () => window.location.pathname,
  useSearchParams: () => {
    const key = window.location.search;
    if (cachedSearchParams === null || cachedSearchKey !== key) {
      cachedSearchKey = key;
      cachedSearchParams = new URLSearchParams(key);
    }
    return cachedSearchParams;
  },
}));

// The map + surrounding panels are irrelevant to the fluid-commit contract and
// pull in maplibre-gl (heavy, browser-only) — stub them out. PresetPanel is
// left real: it's the actual UI surface `onPreset` is wired to. The map and
// KPI-strip stubs render POSITION MARKERS (and capture props) so the
// panorama-redesign composition tests can assert DOM order + the frame prop.
let mapProps: Record<string, unknown> | null = null;
let layerPanelProps: {
  states?: Record<string, Record<string, unknown>>;
  onToggle?: (id: string) => void;
} | null = null;

vi.mock("@/components/panorama/SituationalMapDynamic", () => ({
  SituationalMapDynamic: (props: Record<string, unknown>) => {
    mapProps = props;
    // v2C: the console's scope pill + period segmented arrive via the
    // `topRightSlot` prop (the real map renders them in its floating top-right
    // cluster) — render the slot so the scope/period assertions see it. The
    // legacy `bottomDock` slot is kept for any straggler usage.
    return (
      <div data-testid="map-region">
        {props.topRightSlot as ReactNode}
        {props.bottomDock as ReactNode}
      </div>
    );
  },
}));
vi.mock("@/components/panorama/DetailDrawer", () => ({
  DetailDrawer: () => null,
}));
vi.mock("@/components/panorama/LayerPanel", () => ({
  LayerPanel: (props: {
    states?: Record<string, Record<string, unknown>>;
    onToggle?: (id: string) => void;
  }) => {
    layerPanelProps = props;
    return null;
  },
}));
// panorama-vista-redesign Phase 3: PanoramaKpiStrip was retired from its
// mount (extracted into PanoramaKpiFooter + PanoramaMetricsColumn). Stub the
// footer as the DOM-order position marker; the metrics column is left REAL
// (it renders the actual per-vista KPI tiles the redesign is about).
vi.mock("@/components/panorama/PanoramaKpiFooter", () => ({
  PanoramaKpiFooter: () => <div data-testid="kpi-strip" />,
}));
// TimeScrubber is deliberately REAL (design-QA 2026-07-04 P0): the control
// budget below must hold with the actual scrubber rendered, not mocked away —
// mocking it made the ≤8 assertion dishonest vs production first paint.

import type { PanoramaKpis } from "@/src/modules/panorama/application/get-panorama-kpis";
import { PanoramaConsole } from "./PanoramaConsole";

const EMPTY_FC = { type: "FeatureCollection" as const, features: [] };
const INITIAL_KPIS = { kpis: [], recalculatedFor: "Nacional · este mes", dataAsOf: null };
// A REAL (non-empty) loaded strip with a flat/no-delta tile — buildPanoramaReading
// falls back to "Sin variación destacable…" (the legit all-clear for a LOADED but
// flat strip), and the strip is NOT degraded (tiles present). Distinct from the
// EMPTY strip, which now reads as a failure state (empty ≠ all-clear, fix #1).
const REAL_KPIS: PanoramaKpis = {
  kpis: [
    {
      id: "mordeduras",
      label: "Mordeduras / 10k hab.",
      value: "1,2",
      tone: "warn",
      info: { definition: "d" },
      href: "/gob/vigilancia",
      source: "s",
    },
  ],
  recalculatedFor: "Nacional · este mes",
  dataAsOf: null,
};
const OK_ENVELOPE = { features: EMPTY_FC, truncated: false, suppressedCount: 0 };

// Deferred-promise mode (panorama-redesign abort tests): when `deferMode` is
// on, each fetch stays pending until its entry in `deferred` is resolved —
// and rejects with an AbortError when its AbortSignal fires, mirroring the
// real fetch contract. Default mode resolves instantly (legacy tests).
type DeferredFetch = {
  url: string;
  signal: AbortSignal | null;
  resolve: (body: unknown) => void;
};
let deferMode = false;
let deferred: DeferredFetch[] = [];

const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  const signal = init?.signal ?? null;
  if (!deferMode) {
    // The KPI endpoint returns a PanoramaKpis payload, not a layer envelope —
    // setKpis with the wrong shape would crash the PanoramaReading render.
    const body = url.includes("/api/panorama/kpis") ? INITIAL_KPIS : OK_ENVELOPE;
    return Promise.resolve({ ok: true, json: async () => body } as unknown as Response);
  }
  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    signal?.addEventListener("abort", () =>
      reject(new DOMException("The operation was aborted.", "AbortError")),
    );
    deferred.push({
      url,
      signal,
      resolve: (body) => resolve({ ok: true, json: async () => body } as unknown as Response),
    });
  });
});

function setUrl(url: string) {
  window.history.replaceState(null, "", url);
  cachedSearchKey = null;
  cachedSearchParams = null;
}

function renderConsole() {
  return render(
    <PanoramaConsole
      defaultLayerId="perdidas"
      defaultFeatures={EMPTY_FC}
      initialKpis={INITIAL_KPIS}
    />,
  );
}

beforeEach(() => {
  routerPush.mockClear();
  routerReplace.mockClear();
  routerRefresh.mockClear();
  fetchMock.mockClear();
  deferMode = false;
  deferred = [];
  mapProps = null;
  layerPanelProps = null;
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.clear();
  setUrl("/gob/panorama");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PanoramaConsole onPreset — fluid shallow commit (supersedes the 0e94f198 interim cure)", () => {
  it("commits the preset board via history.pushState, preserving other params, without any reload", () => {
    setUrl("/gob/panorama?province=AR-B");
    renderConsole();
    const pushSpy = vi.spyOn(window.history, "pushState");

    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Señales de brote/ }));

    expect(pushSpy).toHaveBeenCalledTimes(1);
    // The URL updated in place — same document, no navigation.
    const params = new URLSearchParams(window.location.search);
    expect(params.get("province")).toBe("AR-B");
    // "brotes-activos" is a 90d preset with base cobertura + signal zoonosis.
    expect(params.get("period")).toBe("90d");
    expect(params.get("preset")).toBe("brotes-activos");
    expect(params.get("layers")).toBe("zoonosis,cobertura");
    expect(window.location.pathname).toBe("/gob/panorama");
  });

  it("never calls router.push/replace/refresh — the commit bypasses the router entirely", () => {
    renderConsole();

    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Señales de brote/ }));

    expect(routerPush).not.toHaveBeenCalled();
    expect(routerReplace).not.toHaveBeenCalled();
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it("fetches the preset's layers client-side against the NEW period", async () => {
    renderConsole();

    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Señales de brote/ }));

    await waitFor(() => {
      const layerCalls = fetchMock.mock.calls
        .map((c) => String(c[0]))
        // Feature fetches only — the scrubber histogram (?histogram=1) is a
        // separate scope-total call with its own period lifecycle.
        .filter(
          (u) =>
            u.startsWith("/api/panorama/") &&
            !u.includes("/kpis") &&
            !u.includes("histogram=1") &&
            // The rule-change marker fetch is scope-keyed, period-independent
            // (markers outside the window are dropped client-side).
            !u.includes("/rule-changes"),
        );
      expect(layerCalls.some((u) => u.includes("/api/panorama/cobertura"))).toBe(true);
      expect(layerCalls.some((u) => u.includes("/api/panorama/zoonosis"))).toBe(true);
      // Every layer fetch carries the preset's period — no stale closure.
      for (const u of layerCalls) expect(u).toContain("period=90d");
    });
  });

  it("persists the committed board to localStorage for the bare-URL restore", () => {
    renderConsole();

    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Señales de brote/ }));

    const raw = window.localStorage.getItem("panorama:board:v1");
    expect(raw).not.toBeNull();
    const board = JSON.parse(raw as string) as Record<string, unknown>;
    expect(board.layers).toBe("zoonosis,cobertura");
    expect(board.preset).toBe("brotes-activos");
    expect(board.period).toBe("90d");
  });
});

describe("PanoramaConsole — Desierto veterinario vista (new-vistas wave)", () => {
  it("commits the desierto board shallow (preset/layers/period=90d) and fetches its layer", async () => {
    renderConsole();
    // spyOn returns the SAME accumulated spy when pushState is already spied
    // (earlier tests in this file) — clear it so the count below is THIS click's.
    const pushSpy = vi.spyOn(window.history, "pushState");
    pushSpy.mockClear();

    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Desierto veterinario/ }));

    // Same preset-commit mechanism as every vista: ONE shallow push, no router.
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(routerPush).not.toHaveBeenCalled();
    const params = new URLSearchParams(window.location.search);
    expect(params.get("preset")).toBe("desierto-veterinario");
    // The vista's N: 90 days without registered vet activity (the period IS N).
    expect(params.get("period")).toBe("90d");
    // Orphan-wiring 2026-07-26: the vista now also activates the two INSTALLED
    // CAPACITY directories (clínicas + refugios) as reference layers, so the
    // diagnosis ships with the network you could deploy through. Reference
    // layers are unlimited under F2 — they take neither the base nor the signal
    // slot — and the registry order here is the console's own layer ordering,
    // not the preset's activation order.
    expect(params.get("layers")).toBe("refugios,clinicas,desierto-veterinario");

    await waitFor(() => {
      const layerCalls = fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter(
          (u) =>
            u.startsWith("/api/panorama/") &&
            !u.includes("/kpis") &&
            !u.includes("histogram=1") &&
            // The rule-change marker fetch is scope-keyed, period-independent
            // (markers outside the window are dropped client-side).
            !u.includes("/rule-changes"),
        );
      expect(layerCalls.some((u) => u.includes("/api/panorama/desierto-veterinario"))).toBe(true);
      for (const u of layerCalls) expect(u).toContain("period=90d");
    });
  });
});

describe("PanoramaConsole — Acceso veterinario vista (polarity carried into the ranking)", () => {
  // acceso-veterinario is the one layer whose value is GOOD when it is high
  // (visitas por 1.000 mascotas activas). The registry declares that
  // (`higherIsBetter: true`) and `rankWorstUnits` honours it, but the console
  // built its rank options inline and never passed the flag through — so the
  // ten BEST-served jurisdictions were listed under a "Peores 10" heading.
  const provinceEnvelope = (cells: Array<{ code: string; name: string; value: number }>) => ({
    features: {
      type: "FeatureCollection" as const,
      features: cells.map((c) => ({
        type: "Feature" as const,
        geometry: null,
        properties: { provinceCode: c.code, province: c.name, value: c.value },
      })),
    },
    truncated: false,
    suppressedCount: 0,
  });

  function stubLayerFetch(layerId: string, body: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        const payload = url.includes("/api/panorama/kpis")
          ? INITIAL_KPIS
          : url.includes(`/api/panorama/${layerId}`) && !url.includes("histogram=1")
            ? body
            : OK_ENVELOPE;
        return Promise.resolve({ ok: true, json: async () => payload } as unknown as Response);
      }),
    );
  }

  it("ranks the LEAST-served jurisdiction first — a high rate is the good news", async () => {
    stubLayerFetch(
      "acceso-veterinario",
      provinceEnvelope([
        { code: "AR-M", name: "Mendoza", value: 1997.9 },
        { code: "AR-A", name: "Salta", value: 690.9 },
        { code: "AR-Q", name: "Neuquén", value: 1145.4 },
      ]),
    );
    renderConsole();

    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Acceso veterinario/ }));
    fireEvent.click(screen.getByRole("tab", { name: /Estadísticas/ }));

    await waitFor(() => {
      const rows = screen.getAllByRole("row").slice(1); // skip the header row
      expect(rows.length).toBeGreaterThan(0);
      // Salta (690,9 — the WORST access) must head the list, not Mendoza.
      expect(within(rows[0]).getByText("Salta")).toBeVisible();
      expect(within(rows[rows.length - 1]).getByText("Mendoza")).toBeVisible();
    });
  });
});

describe("PanoramaConsole — Tendencia vista (new-vistas wave)", () => {
  it("commits the tendencia board shallow (preset/layers/period=30d) and fetches its layer", async () => {
    renderConsole();
    const pushSpy = vi.spyOn(window.history, "pushState");
    pushSpy.mockClear();

    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Tendencia/ }));

    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(routerPush).not.toHaveBeenCalled();
    const params = new URLSearchParams(window.location.search);
    expect(params.get("preset")).toBe("tendencia");
    // 30d vs the prior 30d — the operational trend cadence.
    expect(params.get("period")).toBe("30d");
    expect(params.get("layers")).toBe("tendencia");

    await waitFor(() => {
      const layerCalls = fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter(
          (u) =>
            u.startsWith("/api/panorama/") &&
            !u.includes("/kpis") &&
            !u.includes("histogram=1") &&
            // The rule-change marker fetch is scope-keyed, period-independent
            // (markers outside the window are dropped client-side).
            !u.includes("/rule-changes"),
        );
      expect(layerCalls.some((u) => u.includes("/api/panorama/tendencia"))).toBe(true);
      for (const u of layerCalls) expect(u).toContain("period=30d");
    });
  });
});

describe("PanoramaConsole — Mordeduras×PPP vista (D1 rename of riesgo-ppp, declared bivariate pair)", () => {
  it("commits the cruce-mordeduras-ppp board shallow (ppp base + mordeduras overlay) and fetches both axes", async () => {
    renderConsole();
    const pushSpy = vi.spyOn(window.history, "pushState");
    pushSpy.mockClear();

    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Mordeduras sobre bajo registro PPP/ }));

    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(routerPush).not.toHaveBeenCalled();
    const params = new URLSearchParams(window.location.search);
    expect(params.get("preset")).toBe("cruce-mordeduras-ppp");
    expect(params.get("period")).toBe("90d");
    // Registry order (canonicalLayersKey): mordeduras precedes ppp.
    expect(params.get("layers")).toBe("mordeduras,ppp");

    await waitFor(() => {
      const layerCalls = fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter(
          (u) =>
            u.startsWith("/api/panorama/") &&
            !u.includes("/kpis") &&
            !u.includes("histogram=1") &&
            // The rule-change marker fetch is scope-keyed, period-independent
            // (markers outside the window are dropped client-side).
            !u.includes("/rule-changes"),
        );
      // BOTH axes of the declared pair load through the ordinary layer path —
      // the bivariate join reads the same caches, no side-channel fetch.
      expect(layerCalls.some((u) => u.includes("/api/panorama/ppp"))).toBe(true);
      expect(layerCalls.some((u) => u.includes("/api/panorama/mordeduras"))).toBe(true);
      for (const u of layerCalls) expect(u).toContain("period=90d");
    });
  });

  it("opens in its declared bivariate encoding on an IN-SESSION preset click, not just on mount", async () => {
    // Bug: bivariateMode's useState initializer only seeds from the OPENING
    // preset's `encodings` declaration once, at mount — an in-session
    // applyPreset() commit never ran through it, so clicking "Riesgo PPP"
    // from another vista silently opened on the plain ppp fill, its whole
    // point ("¿dónde se cruzan mordeduras altas con bajo registro PPP?")
    // hidden behind a toggle. applyPreset now seeds bivariateMode itself on
    // every commit, mirroring the mount-time seed.
    renderConsole();
    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Mordeduras sobre bajo registro PPP/ }));

    await waitFor(() => {
      const params = new URLSearchParams(window.location.search);
      expect(params.get("preset")).toBe("cruce-mordeduras-ppp");
      expect(params.get("encoding")).toBe("bivariate");
    });

    // Symmetric: switching to a preset that does NOT declare bivariate turns
    // the encoding back off (same as the eligibility-reset effect already
    // does when the axes themselves drop out) — it must never stick around
    // into an unrelated vista.
    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /^Cumplimiento$/ }));

    await waitFor(() => {
      const params = new URLSearchParams(window.location.search);
      expect(params.get("preset")).toBe("cumplimiento");
      expect(params.get("encoding")).toBeNull();
    });
  });
});

describe("PanoramaConsole — D1 metric selector (merged Cumplimiento vista)", () => {
  it("switching metric keeps the preset id, swaps base layer + URL layers through the same commit", async () => {
    renderConsole();

    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /^Cumplimiento$/ }));
    let params = new URLSearchParams(window.location.search);
    expect(params.get("preset")).toBe("cumplimiento");
    expect(params.get("layers")).toBe("cobertura");

    // The selector renders INSIDE the vista panel, only for the merged vista.
    openVista();
    const metricGroup = screen.getByRole("radiogroup", { name: "Métrica" });
    expect(
      within(metricGroup)
        .getAllByRole("radio")
        .map((r) => r.textContent),
    ).toEqual(["Antirrábica", "Esterilización", "Registro PPP", "Microchip", "Desparasitación"]);
    // Default metric derived from the layer set: Antirrábica.
    expect(within(metricGroup).getByRole("radio", { name: "Antirrábica" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    fireEvent.click(within(metricGroup).getByRole("radio", { name: "Esterilización" }));

    // SAME preset id, DIFFERENT base — the metric switch is a board commit, not
    // a parallel path: URL, persistence and fetches all move together.
    params = new URLSearchParams(window.location.search);
    expect(params.get("preset")).toBe("cumplimiento");
    expect(params.get("layers")).toBe("esterilizacion");
    expect(params.get("period")).toBe("90d");
    const raw = window.localStorage.getItem("panorama:board:v1");
    const board = JSON.parse(raw as string) as Record<string, unknown>;
    expect(board.preset).toBe("cumplimiento");
    expect(board.layers).toBe("esterilizacion");

    await waitFor(() => {
      const layerCalls = fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter(
          (u) =>
            u.startsWith("/api/panorama/") &&
            !u.includes("/kpis") &&
            !u.includes("histogram=1") &&
            !u.includes("/rule-changes"),
        );
      expect(layerCalls.some((u) => u.includes("/api/panorama/esterilizacion"))).toBe(true);
    });

    // Re-derivation round-trip: the vista radio stays checked (the badge never
    // flips to "personalizada") and the metric radio re-derives from the layers.
    openVista();
    expect(screen.getByRole("radio", { name: /^Cumplimiento$/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      within(screen.getByRole("radiogroup", { name: "Métrica" })).getByRole("radio", {
        name: "Esterilización",
      }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("Volver a returns to the metric the operator LEFT, not the default (review F2)", async () => {
    renderConsole();

    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /^Cumplimiento$/ }));
    openVista();
    const metricGroup = screen.getByRole("radiogroup", { name: "Métrica" });
    fireEvent.click(within(metricGroup).getByRole("radio", { name: "Esterilización" }));
    expect(new URLSearchParams(window.location.search).get("layers")).toBe("esterilizacion");

    // The metric switch is a BOARD COMMIT with an async tail (the new base's
    // layer fetch, which lands with `active: true`). Hand-editing before that
    // tail settles races it: the commit re-activates `esterilizacion` after the
    // uncheck, the vista re-derives, and `personalizadaFrom` is cleared — the
    // notice below never appears (or appears and vanishes). This is exactly the
    // wait its sibling test above already performs; only this test omitted it,
    // which is why it passed on a fast machine and went red on CI.
    await waitFor(() => {
      expect(
        fetchMock.mock.calls
          .map((c) => String(c[0]))
          .some((u) => u.startsWith("/api/panorama/esterilizacion")),
      ).toBe(true);
    });

    // Hand-edit: deactivating the base flips the board to personalizada.
    openFiltro();
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox", { name: /Cobertura de esterilización/ }));
    });

    // The one-tap return must repaint Cumplimiento·Esterilización — a bare
    // preset id here would silently paint the DEFAULT metric (cobertura), the
    // exact metric-loss class the D1 aliases fence on the URL path.
    //
    // Wait for the AFFORDANCE ITSELF, never for a proxy element: the old
    // `findByText(/personalizada/)` + synchronous `getByRole` pair synchronized
    // on the notice's prose and then read its button in the same tick, so any
    // extra render between the two lost the button. The guarantee asserted is
    // unchanged — a button named "Volver a Cumplimiento" must exist, and
    // clicking it must restore BOTH the preset and the metric the operator left.
    const volver = await screen.findByRole("button", { name: /Volver a Cumplimiento/ });
    fireEvent.click(volver);
    await waitFor(() => {
      const params = new URLSearchParams(window.location.search);
      expect(params.get("preset")).toBe("cumplimiento");
      expect(params.get("layers")).toBe("esterilizacion");
    });
  });

  it("does not offer the selector on a vista without metricOptions", () => {
    renderConsole();

    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Señales de brote/ }));

    openVista();
    expect(screen.queryByRole("radiogroup", { name: "Métrica" })).not.toBeInTheDocument();
  });
});

// PO 2026-08-01, from a live capture of
//   /admin/panorama?layers=mordeduras,ppp&period=90d&preset=riesgo-ppp&encoding=bivariate
// at national scope: "las referencias de colores y círculos no son consistentes
// con lo mostrado en el mapa".
//
// Two lies on that one strip, both of the RA-7 F9/F10 family (a legend may not
// name a mark the frame does not paint):
//
//  1. the axis caption was the LITERAL "cobertura × señal" — the OTHER declared
//     pair's vocabulary — while the matrix crossed registro PPP × mordeduras;
//  2. an orange "Mordeduras / antirrábica" dot promised circles on a canvas
//     with none, because `legendLayerDots` read `activeLayers` (what was
//     REQUESTED) instead of `mapLayers` (what is PAINTED). Under the bivariate
//     encoding those differ by exactly the signal layer, which is folded into
//     the 3×3 matrix and removed from the map.
//
// The dot bug reached BOTH pill states from one derivation: `visibleDots` feeds
// the collapsed strip AND the expanded repeat.
describe("PanoramaConsole — the bivariate strip describes the frame it is over", () => {
  /** 9 provinces with a real spread — enough units and non-degenerate terciles
   *  for `bivariateViable`, so the encoding actually engages. */
  const PROV = ["AR-B", "AR-C", "AR-X", "AR-S", "AR-M", "AR-T", "AR-E", "AR-N", "AR-Q"];

  /** How many of the 9 signal cells come back k-anon suppressed. Under
   *  BIVARIATE_MAX_SUPPRESSED_SHARE (0.5) so the encoding still engages. */
  let suppressedSignals = 0;

  function bivariateFetch(input: RequestInfo | URL): Promise<Response> {
    const url = String(input);
    let body: unknown = OK_ENVELOPE;
    if (url.includes("/api/panorama/kpis")) {
      body = INITIAL_KPIS;
    } else if (url.includes("/api/panorama/ppp")) {
      body = {
        features: {
          type: "FeatureCollection",
          features: PROV.map((code, i) => ({
            type: "Feature",
            geometry: null,
            properties: {
              provinceCode: code,
              province: code,
              value: 10 + i * 9,
              suppressed: false,
            },
          })),
        },
        truncated: false,
        suppressedCount: 0,
      };
    } else if (url.includes("/api/panorama/mordeduras")) {
      body = {
        features: {
          type: "FeatureCollection",
          features: PROV.map((code, i) => ({
            type: "Feature",
            geometry: { type: "Point", coordinates: [-60, -34] },
            properties:
              i < suppressedSignals
                ? { province: code, count: null, suppressed: true }
                : { province: code, count: 7 + i * 5, suppressed: false },
          })),
        },
        truncated: false,
        suppressedCount: 0,
      };
    }
    return Promise.resolve({ ok: true, json: async () => body } as unknown as Response);
  }

  async function openRiesgoPpp(opts?: { suppressed?: number }) {
    suppressedSignals = opts?.suppressed ?? 0;
    // A LOCAL stub, never `fetchMock.mockImplementation` — the shared mock is
    // only `mockClear`ed between tests, so an implementation swap would leak
    // into every later case (it broke the two deferMode abort tests).
    vi.stubGlobal("fetch", vi.fn(bivariateFetch));
    // DELIBERATELY the LEGACY `?preset=riesgo-ppp` id (D1 rename): a pre-merge
    // shared link must keep reproducing the bivariate view — the alias resolves
    // and the strip below still engages.
    setUrl("/gob/panorama?layers=mordeduras,ppp&period=90d&preset=riesgo-ppp&encoding=bivariate");
    renderConsole();
    // Wait until the encoding has actually engaged — the strip only makes its
    // bivariate claims once the 3×3 matrix is what the map paints.
    await waitFor(() => {
      expect(screen.getByText("Intensidad combinada")).toBeInTheDocument();
    });
  }

  it("names the axes THIS pair crosses, never the other pair's vocabulary", async () => {
    await openRiesgoPpp();

    expect(screen.getByText("Registro PPP × Mordeduras")).toBeInTheDocument();
    expect(screen.queryByText("cobertura × señal")).not.toBeInTheDocument();
  });

  it("shows no point-layer dot for a layer folded into the matrix", async () => {
    await openRiesgoPpp();

    // `mordeduras` is `geomType: "point"` and IS active — but the bivariate
    // encoding drops it from `mapLayers` and paints not one circle. The strip
    // used to show its orange dot anyway, in both the collapsed summary and the
    // expanded repeat (one `visibleDots` array feeds both), so a zero here also
    // covers the expanded panel the PO flagged.
    expect(screen.queryAllByText("Mordeduras / antirrábica")).toHaveLength(0);
  });

  // The RA-7 F9/F10 rule in its THIRD form, spotted on the same capture: the
  // bivariate method caption asserted "Una provincia protegida por privacidad
  // (k-anonimato) se muestra con trama, nunca con color" on EVERY bivariate
  // frame. It sends the reader hunting for a texture; on a fully-classified
  // frame there is none to find, and a reader who learns the notices are
  // decoration stops reading the privacy one.
  const TRAMA = /se muestra con trama, nunca con color/;

  it("does not promise a k-anon trama on a frame that paints none", async () => {
    await openRiesgoPpp();

    expect(screen.queryByText(TRAMA)).not.toBeInTheDocument();
    // The method sentence itself still stands — only the unearned claim is gone.
    expect(screen.getByText(/Terciles calculados sobre la distribución/)).toBeInTheDocument();
  });

  it("does promise it the moment the frame actually hatches a province", async () => {
    await openRiesgoPpp({ suppressed: 2 });

    expect(screen.getByText(TRAMA)).toBeInTheDocument();
  });
});

describe("PanoramaConsole — bare-URL board restore (subtle, not sticky)", () => {
  it("restores a saved board on a bare URL via shallow replaceState + client fetch", async () => {
    window.localStorage.setItem(
      "panorama:board:v1",
      JSON.stringify({
        layers: "cobertura,zoonosis",
        level: "province",
        preset: "brotes-activos",
        period: "90d",
      }),
    );
    renderConsole();

    await waitFor(() => {
      const params = new URLSearchParams(window.location.search);
      expect(params.get("layers")).toBe("zoonosis,cobertura");
      expect(params.get("period")).toBe("90d");
    });
    // Restored WITHOUT touching the router (no navigation, no reload).
    expect(routerPush).not.toHaveBeenCalled();
    expect(routerReplace).not.toHaveBeenCalled();
    await waitFor(() => {
      const layerCalls = fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.startsWith("/api/panorama/") && !u.includes("/kpis"));
      expect(layerCalls.some((u) => u.includes("/api/panorama/cobertura"))).toBe(true);
    });
  });

  it("does NOT restore when the URL already carries explicit board/period params", () => {
    window.localStorage.setItem(
      "panorama:board:v1",
      JSON.stringify({
        layers: "cobertura",
        level: "province",
        preset: null,
        period: "90d",
      }),
    );
    setUrl("/gob/panorama?period=30d");
    renderConsole();

    const params = new URLSearchParams(window.location.search);
    expect(params.get("period")).toBe("30d");
    expect(params.get("layers")).toBeNull();
  });

  // T1.6: the restore used to be SILENT — the URL was rewritten in place and
  // the operator had no way to tell this board came from localStorage rather
  // than from the link they opened. The restore now announces itself once,
  // dismissibly, in the same visual pattern as the "Editaste la vista" note.
  it("announces the saved-board restore with 'Continuando tu vista anterior.' (dismissible)", async () => {
    window.localStorage.setItem(
      "panorama:board:v1",
      JSON.stringify({
        layers: "cobertura,zoonosis",
        level: "province",
        preset: "brotes-activos",
        period: "90d",
      }),
    );
    renderConsole();

    expect(await screen.findByText("Continuando tu vista anterior.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Descartar aviso" }));
    expect(screen.queryByText("Continuando tu vista anterior.")).not.toBeInTheDocument();
  });

  it("does NOT announce a restore when the URL pins the board explicitly (menu-click path, T1.5)", () => {
    window.localStorage.setItem(
      "panorama:board:v1",
      JSON.stringify({
        layers: "cobertura,zoonosis",
        level: "province",
        preset: "brotes-activos",
        period: "90d",
      }),
    );
    // The nav entry's canonical href (T1.5) — explicit params, no restore.
    setUrl("/gob/panorama?preset=sintomas&period=30d");
    renderConsole();

    expect(screen.queryByText("Continuando tu vista anterior.")).not.toBeInTheDocument();
    // The explicit URL stayed the source of truth.
    const params = new URLSearchParams(window.location.search);
    expect(params.get("preset")).toBe("sintomas");
    expect(params.get("period")).toBe("30d");
  });

  it("reading a pre-redesign v1 entry (no capasDetail/scrubDetail) restores cleanly, defaulting to Simple", async () => {
    // A `panorama:board:v1` entry saved BEFORE panorama-vista-redesign — the
    // exact pre-redesign shape (design Decision 5: no version bump, tolerant
    // OPTIONAL fields).
    window.localStorage.setItem(
      "panorama:board:v1",
      JSON.stringify({
        layers: "cobertura,zoonosis",
        level: "province",
        preset: "brotes-activos",
        period: "90d",
      }),
    );

    // No JSON.parse failure, no crash — the console mounts normally.
    expect(() => renderConsole()).not.toThrow();

    await waitFor(() => {
      const params = new URLSearchParams(window.location.search);
      expect(params.get("layers")).toBe("zoonosis,cobertura");
    });
    // P3.6: the Simple/Detalle toggle was removed from Capas — the panel always
    // renders full detail now, so opening it mounts NO Simple/Detalle button.
    // (A legacy board with/without capasDetail restores without crashing.)
    openFiltro();
    expect(
      screen.queryByRole("button", { name: "Modo simple de Capas del mapa" }),
    ).not.toBeInTheDocument();
  });
});

describe("PanoramaConsole — browser Back re-derives the board from the popped URL (MAP-2)", () => {
  it("reverts the active preset when popstate reverts ?preset (tab/legend/KPIs follow the URL)", () => {
    renderConsole();

    // Commit preset A, then preset B — two history entries.
    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Señales de brote/ }));
    const urlAfterA = `${window.location.pathname}${window.location.search}`;
    expect(new URLSearchParams(window.location.search).get("preset")).toBe("brotes-activos");

    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Bienestar/ }));
    expect(new URLSearchParams(window.location.search).get("preset")).toBe("bienestar");
    openVista();
    expect(screen.getByRole("radio", { name: /Bienestar/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    // Simulate browser Back: the URL reverts to A and popstate fires. In this Next
    // version useSearchParams does NOT observe popstate — the console must re-derive
    // the board from the popped URL itself.
    act(() => {
      window.history.replaceState(null, "", urlAfterA);
      cachedSearchKey = null;
      cachedSearchParams = null;
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    // The view re-derived: preset A is active again, B is not — the tab/legend/KPIs
    // (all preset-driven) follow the reverted URL instead of staying on B.
    expect(new URLSearchParams(window.location.search).get("preset")).toBe("brotes-activos");
    openVista();
    expect(screen.getByRole("radio", { name: /Señales de brote/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    openVista();
    expect(screen.getByRole("radio", { name: /Bienestar/ })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("preserves the popped URL's period + layers across Back — never rewrites them to the preset default (adversarial review MED #1)", async () => {
    renderConsole();

    // Preset A at its default window (90d)…
    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Señales de brote/ }));
    // …then the operator customizes the period to 12m — a shallow replace that
    // keeps preset=A in the URL (the period picker's commit shape).
    act(() => {
      const params = new URLSearchParams(window.location.search);
      params.set("period", "12m");
      window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
    });
    const urlAfterPeriod = `${window.location.pathname}${window.location.search}`;
    expect(new URLSearchParams(window.location.search).get("period")).toBe("12m");

    // Preset B — a new history entry back at B's default window.
    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Bienestar/ }));
    expect(new URLSearchParams(window.location.search).get("preset")).toBe("bienestar");
    fetchMock.mockClear();

    // Browser Back → the popped URL still says preset=A & period=12m.
    act(() => {
      window.history.replaceState(null, "", urlAfterPeriod);
      cachedSearchKey = null;
      cachedSearchParams = null;
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    // Preset A is active again…
    openVista();
    expect(screen.getByRole("radio", { name: /Señales de brote/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // …and the POPPED board fields survive verbatim: the resync must restore
    // period/layers FROM the popped URL — the old reuse of the click-path
    // applyPreset forced period back to A's default (90d) and rewrote the URL.
    const popped = new URLSearchParams(window.location.search);
    expect(popped.get("period")).toBe("12m");
    expect(popped.get("preset")).toBe("brotes-activos");
    expect(popped.get("layers")).toBe("zoonosis,cobertura");

    // The restored layer set refetches at the POPPED window (12m), never 90d.
    await waitFor(() => {
      const layerCalls = fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter(
          (u) =>
            u.startsWith("/api/panorama/") &&
            !u.includes("/kpis") &&
            !u.includes("histogram=1") &&
            // The rule-change marker fetch is scope-keyed, period-independent
            // (markers outside the window are dropped client-side).
            !u.includes("/rule-changes"),
        );
      expect(layerCalls.some((u) => u.includes("/api/panorama/cobertura"))).toBe(true);
      expect(layerCalls.some((u) => u.includes("/api/panorama/zoonosis"))).toBe(true);
      for (const u of layerCalls) expect(u).toContain("period=12m");
    });
    // The KPIs follow the popped window too (popstate is not observed by
    // useSearchParams, so the resync refetches them explicitly).
    await waitFor(() => {
      const kpiCalls = fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.includes("/api/panorama/kpis"));
      expect(kpiCalls.some((u) => u.includes("period=12m"))).toBe(true);
    });
  });
});

describe("PanoramaConsole — PERÍODO commits shallow, no reload (Root B, QA #3b)", () => {
  it("a preset período commits via history.pushState (never location.assign / the router) and refetches KPIs + layers at the new window", async () => {
    // Explicit period suppresses the first-visit default preset — then activate a
    // preset so there ARE active period-sensitive layers (cobertura) to refetch.
    setUrl("/gob/panorama?period=3y");
    renderConsole();
    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Señales de brote/ }));
    // Drain the preset's own 90d layer burst so the assertions below see only the
    // período change's fetches.
    await waitFor(() => {
      const calls = fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.includes("/api/panorama/cobertura") && u.includes("period=90d"));
      expect(calls.length).toBeGreaterThan(0);
    });

    const pushSpy = vi.spyOn(window.history, "pushState");
    pushSpy.mockClear();
    fetchMock.mockClear();

    openPeriodo();
    fireEvent.click(screen.getByRole("button", { name: "30 días" }));

    // Shallow: the URL flipped to 30d in place — a pushState, NO reload. (The old
    // path called window.location.assign; the History push + the router assertions
    // below prove the commit no longer navigates the document.)
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(routerPush).not.toHaveBeenCalled();
    expect(routerReplace).not.toHaveBeenCalled();
    expect(routerRefresh).not.toHaveBeenCalled();
    const params = new URLSearchParams(window.location.search);
    expect(params.get("period")).toBe("30d");
    expect(params.get("from")).toBeNull();
    expect(params.get("to")).toBeNull();
    expect(window.location.pathname).toBe("/gob/panorama");

    // KPIs refetch client-side at the NEW window (useSearchParams can't see the
    // shallow write, so commitPeriod fetches them explicitly).
    await waitFor(() => {
      const kpiCalls = fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.includes("/api/panorama/kpis"));
      expect(kpiCalls.some((u) => u.includes("period=30d"))).toBe(true);
    });
    // The active period-sensitive layer refetches at 30d too.
    await waitFor(() => {
      const layerCalls = fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter(
          (u) =>
            u.startsWith("/api/panorama/") &&
            !u.includes("/kpis") &&
            !u.includes("histogram=1") &&
            // The rule-change marker fetch is scope-keyed, period-independent
            // (markers outside the window are dropped client-side).
            !u.includes("/rule-changes"),
        );
      expect(
        layerCalls.some((u) => u.includes("/api/panorama/cobertura") && u.includes("period=30d")),
      ).toBe(true);
    });
  });

  it("a custom range commits ONCE (revealing 'Personalizado…' does not commit; the single commit fires when both dates are set)", () => {
    setUrl("/gob/panorama?period=3y");
    renderConsole();

    openPeriodo();
    const pushSpy = vi.spyOn(window.history, "pushState");
    pushSpy.mockClear();

    // Revealing the picker must NOT commit (this is the fix for the double-reload).
    fireEvent.click(screen.getByRole("button", { name: /Personalizado/ }));
    expect(new URLSearchParams(window.location.search).get("period")).toBe("3y");
    expect(pushSpy).not.toHaveBeenCalled();

    // Setting only "Desde" still doesn't commit (range incomplete).
    fireEvent.change(screen.getByLabelText("Desde"), { target: { value: "2026-01-01" } });
    expect(new URLSearchParams(window.location.search).get("period")).toBe("3y");
    expect(pushSpy).not.toHaveBeenCalled();

    // Completing the range with "Hasta" commits — exactly ONCE.
    fireEvent.change(screen.getByLabelText("Hasta"), { target: { value: "2026-03-01" } });
    expect(pushSpy).toHaveBeenCalledTimes(1);
    const params = new URLSearchParams(window.location.search);
    expect(params.get("period")).toBe("custom");
    expect(params.get("from")).toBe("2026-01-01");
    expect(params.get("to")).toBe("2026-03-01");
  });

  it("browser Back restores the prior período (popstate resync keeps the highlight coherent)", () => {
    setUrl("/gob/panorama?period=3y");
    renderConsole();

    openPeriodo();
    fireEvent.click(screen.getByRole("button", { name: "30 días" }));
    const urlAfter30 = `${window.location.pathname}${window.location.search}`;
    expect(new URLSearchParams(window.location.search).get("period")).toBe("30d");

    openPeriodo();
    fireEvent.click(screen.getByRole("button", { name: "90 días" }));
    expect(new URLSearchParams(window.location.search).get("period")).toBe("90d");

    // Back → the popped URL says 30d. useSearchParams does not observe popstate,
    // so the console re-derives the board (and the committed window) itself.
    act(() => {
      window.history.replaceState(null, "", urlAfter30);
      cachedSearchKey = null;
      cachedSearchParams = null;
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(new URLSearchParams(window.location.search).get("period")).toBe("30d");
    // The PeriodPanel highlight follows the restored window (committedPeriod).
    openPeriodo();
    expect(screen.getByRole("button", { name: "30 días" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "90 días" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  // T2.7 (browser-verified): applyPreset always overwrites the período with the
  // preset default — the CONTRACT stands, but discarding an operator-chosen
  // window used to be silent. The one-line notice names the window it reset to.
  it("T2.7: a preset switch that resets an explicit operator período says so (dismissible)", () => {
    setUrl("/gob/panorama?period=3y");
    renderConsole();

    // The operator explicitly commits 30 días…
    openPeriodo();
    fireEvent.click(screen.getByRole("button", { name: "30 días" }));
    expect(screen.queryByText(/El período volvió a/)).not.toBeInTheDocument();

    // …then switches vista (Señales de brote defaults to 90d) → the reset speaks.
    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Señales de brote/ }));
    expect(screen.getByText("El período volvió a 90 días con la vista.")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Descartar aviso de período" }));
    expect(screen.queryByText(/El período volvió a/)).not.toBeInTheDocument();
  });

  it("T2.7: no notice when the operator never chose a período (URL default is not an operator choice)", () => {
    setUrl("/gob/panorama?period=3y");
    renderConsole();

    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Señales de brote/ }));
    expect(screen.queryByText(/El período volvió a/)).not.toBeInTheDocument();
  });

  // T2.6 (browser-verified): PeriodPanel rendered a flat radio off ?period=
  // with zero awareness of current-state boards, while the header honestly said
  // "Estado actual" — two period claims over one screen. When every active
  // layer is a current-state snapshot the panel now says the período does not
  // apply and grays the radios out (same layerIdsAreAllCurrentState rule the
  // view card and buildViewMeta already read — ONE clock per screen).
  it("T2.6: an all-current-state board grays the Período panel and states the window doesn't apply", async () => {
    renderConsole();

    // Default board (perdidas — temporal): the panel is a live selector.
    openPeriodo();
    expect(
      screen.queryByText("Esta vista muestra estado actual; el período no aplica."),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "30 días" })).toBeEnabled();

    // Cumplimiento (default metric antirrábica): base cobertura, a current-state rate.
    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /^Cumplimiento$/ }));
    openPeriodo();
    expect(
      screen.getByText("Esta vista muestra estado actual; el período no aplica."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "30 días" })).toBeDisabled();
    // No highlighted selection over an inert control.
    expect(screen.getByRole("button", { name: "90 días" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});

describe("PanoramaConsole — v2C floating dock (collapsed default, tabs, panes)", () => {
  it("ships collapsed by default: the bar + tabs are visible, no pane content mounts", () => {
    const { container } = renderConsole();

    const dock = screen.getByTestId("panorama-dock");
    expect(dock).toBeVisible();
    // The four tabs are reachable from the collapsed bar.
    expect(screen.getByRole("tab", { name: /Registros/ })).toBeVisible();
    expect(screen.getByRole("tab", { name: /Estadísticas/ })).toBeVisible();
    expect(screen.getByRole("tab", { name: /Referencias/ })).toBeVisible();
    expect(screen.getByRole("tab", { name: /Línea de tiempo/ })).toBeVisible();
    // Collapsed: the tabpanel exists (APG completeness) but is `hidden` and
    // mounts no pane content — no scrubber, no table.
    const panel = container.querySelector("#pano-dock-panel");
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute("hidden");
    expect(container.querySelector("input[type='range']")).toBeNull();
    expect(screen.getByRole("button", { name: "▴ Expandir" })).toBeVisible();
  });

  it("clicking a tab while collapsed expands the dock onto that pane; Colapsar closes it", () => {
    const { container } = renderConsole();

    fireEvent.click(screen.getByRole("tab", { name: /Estadísticas/ }));
    const panel = container.querySelector("#pano-dock-panel");
    expect(panel).not.toBeNull();
    // Expanded: the panel is no longer hidden.
    expect(panel).not.toHaveAttribute("hidden");
    expect(screen.getByRole("tab", { name: /Estadísticas/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "▾ Colapsar" }));
    // Collapsed again: the panel stays in the DOM (APG completeness) but hidden.
    expect(container.querySelector("#pano-dock-panel")).toHaveAttribute("hidden");
  });

  // a11y round (task #43 + review round 2) — dock tab semantics.
  it("A11Y A1 (WCAG 4.1.2 / APG): dock tabs carry a VALID aria-controls in both states (panel always in DOM)", () => {
    renderConsole();

    // Collapsed default: the #pano-dock-panel tabpanel is ALWAYS rendered (hidden
    // when collapsed), so aria-controls is a valid IDREF in both states —
    // completing the tablist/tab/tabpanel APG contract (review round 2 refined
    // the earlier "drop aria-controls when collapsed" fix, which cleared the
    // dangling-IDREF axe hit but left the APG pattern incomplete).
    const collapsedPanel = document.getElementById("pano-dock-panel");
    expect(collapsedPanel).not.toBeNull();
    expect(collapsedPanel).toHaveAttribute("hidden");
    for (const name of [/Registros/, /Estadísticas/, /Referencias/, /Línea de tiempo/]) {
      expect(screen.getByRole("tab", { name })).toHaveAttribute("aria-controls", "pano-dock-panel");
    }

    // Expand → the same panel becomes visible (not re-created).
    fireEvent.click(screen.getByRole("tab", { name: /Estadísticas/ }));
    expect(screen.getByRole("tab", { name: /Estadísticas/ })).toHaveAttribute(
      "aria-controls",
      "pano-dock-panel",
    );
    expect(document.getElementById("pano-dock-panel")).not.toHaveAttribute("hidden");
  });

  it("A11Y M3 (ARIA APG): dock tablist uses roving tabindex + Arrow/Home/End, manual activation", () => {
    renderConsole();
    const stats = screen.getByRole("tab", { name: /Estadísticas/ });
    const registros = screen.getByRole("tab", { name: /Registros/ });
    const referencias = screen.getByRole("tab", { name: /Referencias/ });
    const timeline = screen.getByRole("tab", { name: /Línea de tiempo/ });

    // Only the active tab is Tab-stoppable. C10 (P3.6): the dock now defaults to
    // "Estadísticas" (not "Registros 0", which read as a false "vacío"), so it is
    // the selected + Tab-stoppable tab.
    expect(stats).toHaveAttribute("tabindex", "0");
    expect(registros).toHaveAttribute("tabindex", "-1");
    expect(referencias).toHaveAttribute("tabindex", "-1");
    expect(timeline).toHaveAttribute("tabindex", "-1");

    // ArrowRight moves FOCUS to the NEXT tab in DOM order (dock redesign order:
    // Estadísticas · Registros ‖ Referencias · Línea de tiempo), without
    // switching the pane.
    stats.focus();
    fireEvent.keyDown(stats, { key: "ArrowRight" });
    expect(registros).toHaveFocus();
    expect(registros).toHaveAttribute("tabindex", "0");
    expect(stats).toHaveAttribute("tabindex", "-1");
    // Selection did NOT follow focus (manual activation): still collapsed,
    // Estadísticas still the selected tab.
    expect(stats).toHaveAttribute("aria-selected", "true");
    // Still collapsed: the panel is present but hidden (no pane switch on focus).
    expect(document.getElementById("pano-dock-panel")).toHaveAttribute("hidden");

    // Continuing ArrowRight walks through the DATA | TOOLS boundary (the
    // divider is decorative, not a stop) onto Referencias, then Línea de tiempo.
    fireEvent.keyDown(registros, { key: "ArrowRight" });
    expect(referencias).toHaveFocus();
    fireEvent.keyDown(referencias, { key: "ArrowRight" });
    expect(timeline).toHaveFocus();

    // End → last, Home → first.
    fireEvent.keyDown(timeline, { key: "End" });
    expect(timeline).toHaveFocus();
    fireEvent.keyDown(timeline, { key: "Home" });
    expect(stats).toHaveFocus();
  });

  it("A11Y (review round 2): a mouse click on a tab syncs the roving tabindex to the clicked tab", () => {
    renderConsole();
    const registros = screen.getByRole("tab", { name: /Registros/ });
    const stats = screen.getByRole("tab", { name: /Estadísticas/ });
    const timeline = screen.getByRole("tab", { name: /Línea de tiempo/ });

    // Arrow the roving focus onto the LAST tab (focusIndex now points at timeline).
    registros.focus();
    fireEvent.keyDown(registros, { key: "End" });
    expect(timeline).toHaveAttribute("tabindex", "0");

    // Then MOUSE-click a DIFFERENT tab. The roving position must follow the click
    // (prev bug: focusIndex stayed on timeline, so tabIndex={0} was stranded on
    // the wrong tab under mixed mouse+keyboard use).
    fireEvent.click(stats);
    expect(stats).toHaveAttribute("tabindex", "0");
    expect(timeline).toHaveAttribute("tabindex", "-1");
    expect(registros).toHaveAttribute("tabindex", "-1");
  });

  it("Registros pane hosts the accessible map table (empty-state copy when no aggregate rows)", async () => {
    renderConsole();

    fireEvent.click(screen.getByRole("tab", { name: /Registros/ }));
    // `findByText`, no `getByText`: desde el Lote E paso 2 la tabla entra por
    // `next/dynamic` (MapDataTableDynamic), así que el primer frame del pane es
    // el placeholder y la copia llega cuando resuelve el chunk. Que esta espera
    // sea necesaria ES la prueba de que la tabla ya no viaja en el bundle de la
    // ruta — si `getByText` volviera a alcanzar, la frontera se habría perdido.
    expect(
      await screen.findByText("Sin datos por unidad para las capas activas en este alcance."),
    ).toBeVisible();
  });

  it("Estadísticas pane DROPS the ranking card when nothing justifies it (P2)", () => {
    renderConsole();

    fireEvent.click(screen.getByRole("tab", { name: /Estadísticas/ }));
    // perdidas (density, EMPTY features) → nothing measured, nothing withheld,
    // nothing broken = ABSENT. PO principle P2 (2026-08-04): "la tarjeta no va"
    // — the whole section goes, not just the rows. Superseded the C4 honest-empty
    // copy this test used to assert ("Sin señales en este alcance"), which is
    // still the copy for every NON-absent empty (measured all-clear, failed
    // calculation) and still covered by PanoramaDataTable's own tests.
    expect(screen.queryByText(/Ranking de unidades/)).toBeNull();
    expect(screen.queryByText(/Peores/)).toBeNull();
    expect(screen.queryByText(/Sin señales en este alcance/)).toBeNull();
    // The sibling section stays — P2 hides the empty structure, not the pane.
    expect(screen.getByText(/Actividad por día/)).toBeVisible();
  });
});

describe("PanoramaConsole — deep-link level guard (MAP-5)", () => {
  it("falls a national level=locality deep-link back to province (no province in scope)", () => {
    // No ?province and no implicit jurisdiction province → a locality choropleth
    // has no drilled scope to fill and would read "sin datos en todo el país".
    setUrl("/gob/panorama?level=locality");
    renderConsole();
    // level fell back to province → the on-canvas badge reads "Provincias".
    expect(mapProps?.aggregationLabel).toBe("Provincias");
  });

  it("keeps level=locality when a province IS in scope", () => {
    setUrl("/gob/panorama?level=locality&province=AR-B");
    renderConsole();
    // A drilled province retains locality — the badge names the division, not
    // "Provincias".
    expect(mapProps?.aggregationLabel).toBe("Departamentos/partidos");
  });
});

// ---------------------------------------------------------------------------
// panorama-redesign Fase 1 — reflow composition, control budget, frame, abort
// ---------------------------------------------------------------------------

/** True when `a` precedes `b` in DOM order. */
function isBefore(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

/**
 * Open the "Filtro" rail panel so its layer catalog (Simple/Detalle toggle,
 * LayerPanel) mounts. Task #38 v3 replaced the old top-left "Capas" popover
 * with the floating vertical rail — the layer catalog now lives behind the
 * "Filtro" icon button — so any test that interacts with the Simple/Detalle
 * controls or the LayerPanel must open it first. "Filtro" is unique: the
 * bivariate encoding toggle (Brotes vista) still uses the literal "Capas"
 * label, but that button carries no `aria-expanded`, so it never collides.
 */
function openFiltro(): void {
  fireEvent.click(screen.getByRole("button", { name: "Capas del mapa" }));
}

/**
 * Ensure the "Vista" rail panel is open so the preset radiogroup (PresetPanel)
 * mounts. Task #38 v3: the preset strip moved off the always-visible top-left
 * cluster into the "Vista" rail panel, AND selecting a preset auto-closes the
 * panel (`setRailOpen(null)` in the panel's `onPreset` wrapper) — so this must
 * be called again before every subsequent radio read/click in the same test.
 * Idempotent: only clicks the trigger when the panel isn't already open, so
 * calling it repeatedly never accidentally toggles it closed.
 */
function openVista(): void {
  const trigger = screen.getByRole("button", { name: "Vista" });
  if (trigger.getAttribute("aria-expanded") !== "true") {
    fireEvent.click(trigger);
  }
}

/**
 * Open the "Período" rail panel so PeriodPanel (the preset list + Personalizado)
 * mounts. Idempotent, like openVista — only clicks the trigger when closed.
 */
function openPeriodo(): void {
  const trigger = screen.getByRole("button", { name: "Período" });
  if (trigger.getAttribute("aria-expanded") !== "true") {
    fireEvent.click(trigger);
  }
}

/**
 * Open the v2C dock's "Línea de tiempo" tab so the TimeScrubber mounts. The
 * v2C fixed console moved the scrubber off the always-on bottomDock strip into
 * the floating dock (PO: timeline is opt-in — dock collapsed by default), so
 * any test that interacts with the scrubber must open that tab first.
 *
 * Async (Lote E step 3 prerequisite): the pane's content is about to become a
 * lazy chunk (TimeScrubberDynamic), so after the click we wait for the REAL
 * module to mount — either the scrubber's range input or its own empty state
 * (temporalAvailable=false renders inside TimeScrubber too). With the static
 * import this resolves on the same tick; with the dynamic one it awaits the
 * chunk, keeping every call site correct across both worlds.
 */
async function openTimeline(): Promise<void> {
  fireEvent.click(screen.getByRole("tab", { name: /Línea de tiempo/ }));
  await waitFor(() => {
    const mounted =
      document.querySelector("input[type='range']") ??
      screen.queryByText(/La reproducción temporal necesita una capa de eventos activa/);
    expect(mounted).not.toBeNull();
  });
}

function renderRedesignConsole(extraProps: Record<string, unknown> = {}) {
  return render(
    <PanoramaConsole
      defaultLayerId="perdidas"
      defaultFeatures={EMPTY_FC}
      initialKpis={INITIAL_KPIS}
      filtersSlot={
        <select aria-label="Provincia">
          <option>Todas</option>
        </select>
      }
      {...extraProps}
    />,
  );
}

describe("PanoramaConsole — reflow composition (panorama-vista-redesign Phases 1 & 3)", () => {
  it("v2C composition: masthead-less console = map + overlay clusters; suppression notice + reading live in the legend panel", () => {
    // Explicit period → the first-visit default preset does NOT rewrite the
    // board, so the server-seeded perdidas layer (suppressedCount 3) stays on
    // and the suppression notice renders for the presence assertions.
    setUrl("/gob/panorama?period=3y");
    // A REAL loaded strip (flat tile) so the reading is the legit "Sin variación
    // destacable…" landmark — an EMPTY strip now reads as a failure state (fix #1).
    renderRedesignConsole({ defaultSuppressedCount: 3, initialKpis: REAL_KPIS });

    // Task #38 v3: the "Vista" rail button labels the preset control (right rail).
    const presets = screen.getByRole("button", { name: "Vista" });
    const map = screen.getByTestId("map-region");
    // v2C: the map leads the DOM (overlays are absolute siblings AFTER it).
    expect(isBefore(map, presets)).toBe(true);
    // The k-anon suppression notice + the one-line reading moved into the
    // legend pill's expanded panel — both stay in the accessibility tree
    // (native <details>) so the honesty surfaces are always reachable.
    expect(screen.getByText(/celdas con menos de 5 casos/)).toBeInTheDocument();
    expect(
      screen.getByText("Sin variación destacable frente al período anterior."),
    ).toBeInTheDocument();
    // LIVE PIXEL VERIFICATION 2026-07-30 — this assertion used to read "the
    // legend pill's k-anon marker is ALWAYS visible on the collapsed strip",
    // and THIS FIXTURE is the finding in miniature: the envelope reports
    // suppressedCount 3 over EMPTY_FC, i.e. a count that describes the RESPONSE
    // while the canvas paints nothing. The pill names a canvas MARK, so it must
    // stay silent here...
    expect(screen.queryByText(/k<5 protegido/)).not.toBeInTheDocument();
    // ...while the count-based disclosure in the expanded panel still reports
    // the withheld cells (asserted above). Two different honesty jobs: the
    // notice discloses what the DATA withheld, the pill decodes what the MAP
    // painted. Conflating them is what produced a Ley 25.326 tooltip over a
    // frame with zero hatched units.
    // The floating dock closes the stack.
    expect(screen.getByTestId("panorama-dock")).toBeInTheDocument();
  });

  it("degraded KPIs: KPI-driven conclusion surfaces show a failure state, never a reassuring one (trust/safety)", () => {
    // The KPI fan-out resolved to the honest degraded payload. The one-line
    // reading and the metrics column must REPLACE their reassuring copy with an
    // explicit "no pudimos calcular/cargar" state — the two must never coexist.
    setUrl("/gob/panorama?period=3y");
    const DEGRADED_KPIS: PanoramaKpis = {
      kpis: [],
      recalculatedFor:
        "No pudimos cargar los indicadores en este momento. Reintentá en unos segundos.",
      dataAsOf: null,
      degraded: true,
    };
    renderRedesignConsole({ initialKpis: DEGRADED_KPIS });

    // Honest failure states present…
    expect(screen.getByText("No pudimos calcular la lectura en este momento.")).toBeInTheDocument();
    expect(
      screen.getByText("No pudimos cargar los indicadores en este momento."),
    ).toBeInTheDocument();
    // …and NO reassuring conclusion anywhere on the degraded view.
    expect(
      screen.queryByText("Sin variación destacable frente al período anterior."),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Métricas no disponibles para esta vista.")).not.toBeInTheDocument();
  });

  it("empty KPI strip WITHOUT the degraded flag still reads as a failure, never all-clear (empty ≠ all-clear)", () => {
    // PO instrumented-review finding #1 (2026-07-10): a strip that is EMPTY but
    // carries NO explicit `degraded` sentinel (an older/serialized payload, a
    // 503 body, a partial fixture) must STILL replace the reassuring conclusion
    // — never fall through to buildPanoramaReading([]) → "Sin variación
    // destacable…". Empty ≠ all-clear in a surveillance tool.
    setUrl("/gob/panorama?period=3y");
    const EMPTY_KPIS: PanoramaKpis = {
      kpis: [],
      recalculatedFor: "Recalculado para Nacional",
      dataAsOf: null,
    };
    renderRedesignConsole({ initialKpis: EMPTY_KPIS });

    // Honest failure states present (reading + metrics column)…
    expect(screen.getByText("No pudimos calcular la lectura en este momento.")).toBeInTheDocument();
    expect(
      screen.getByText("No pudimos cargar los indicadores en este momento."),
    ).toBeInTheDocument();
    // …and NO reassuring conclusion despite the missing flag.
    expect(
      screen.queryByText("Sin variación destacable frente al período anterior."),
    ).not.toBeInTheDocument();
  });

  it("hosts the filters slot inside the scope-pill disclosure, next to the Filtro rail button", () => {
    const { container } = renderRedesignConsole();

    // Task #38 v3: the old "Alcance y período" disclosure summary is now the
    // scope pill (same <details>/<summary> disclosure primitive, OverlayDisclosure).
    const scopeSummary = screen.getByTestId("panorama-scope-pill");
    expect(scopeSummary.closest("details")).not.toBeNull();
    // panorama-vista-redesign Phase 2 / task #38 v3: the layer catalog trigger
    // (formerly "Capas", now the rail's "Filtro" icon button) is present.
    expect(screen.getByRole("button", { name: "Capas del mapa" })).toBeInTheDocument();

    // The slot content is REACHABLE (identical behavior, one click away)…
    const filterSelect = screen.getByLabelText("Provincia");
    // …but sits behind the closed disclosure at first paint.
    const details = filterSelect.closest("details");
    expect(details).not.toBeNull();
    expect(details!.hasAttribute("open")).toBe(false);
    expect(container.contains(filterSelect)).toBe(true);
  });

  it("first paint: the rail + Filtro button + the collapsed dock (timeline opt-in) are visible; the scrubber mounts on the timeline tab", async () => {
    // Task #38 v3: the preset strip moved off first-paint into the "Vista" rail
    // panel; the always-visible first-paint control budget is now the rail
    // (7 icon buttons) + KPI cards + dock bar, and the layer catalog stays
    // behind the "Filtro" rail button. The TimeScrubber moved into the floating
    // dock's "Línea de tiempo" tab (PO: timeline is opt-in, dock ships collapsed).
    const { container } = renderRedesignConsole({ defaultSuppressedCount: 3 });

    // At least 6 controls (rail icons, KPI cards, dock tabs/Expandir) are
    // first-paint, none of them behind a closed disclosure.
    expect(
      Array.from(container.querySelectorAll("button")).filter(
        (b) => b.closest("details:not([open])") === null,
      ).length,
    ).toBeGreaterThanOrEqual(6);
    // The "Filtro" trigger is visible at first paint (not behind a disclosure).
    const capasBtn = screen.getByRole("button", { name: "Capas del mapa", expanded: false });
    expect(capasBtn).toBeVisible();
    expect(capasBtn.closest("details:not([open])")).toBeNull();
    // P3.6: the Simple/Detalle toggle was removed from Capas (consistency with
    // the other rail panels) — the panel now always renders full detail, so no
    // Simple/Detalle button ever mounts, even after opening the panel.
    expect(
      screen.queryByRole("button", { name: "Modo simple de Capas del mapa" }),
    ).not.toBeInTheDocument();
    openFiltro();
    expect(
      screen.queryByRole("button", { name: "Modo simple de Capas del mapa" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Modo detalle de Capas del mapa" }),
    ).not.toBeInTheDocument();
    // P3.6: with detail always on, the open Capas panel shows per-layer opacity
    // sliders (range inputs) for active layers — close it so the scrubber range
    // check below is not confounded by them.
    fireEvent.keyDown(document, { key: "Escape" });
    // The dock bar is first-paint (collapsed): its three tabs are reachable but
    // no pane content mounts yet — the scrubber arrives on the timeline tab.
    expect(screen.getByTestId("panorama-dock")).toBeVisible();
    expect(screen.getByRole("tab", { name: /Registros/ })).toBeVisible();
    expect(container.querySelector("input[type='range']")).toBeNull();
    await openTimeline();
    // The scrubber's range input mounts, not behind any details disclosure.
    //
    // ANTI-RESURRECTION GUARD, intentional (documented 2026-07-31 by PO after
    // a sweep for tests that assert dead literals flagged this one). "Reproducir
    // en el tiempo" was the <summary> of a <details> that used to WRAP the
    // scrubber. The literal exists nowhere in source precisely because the
    // disclosure was removed — that absence IS the assertion, and it fails the
    // day someone puts the scrubber back behind a collapsed disclosure. It only
    // LOOKS vacuous; the next sweep should leave it alone.
    expect(screen.queryByText("Reproducir en el tiempo")).not.toBeInTheDocument();
    const range = container.querySelector("input[type='range']");
    expect(range).not.toBeNull();
    expect(range!.closest("details:not([open])")).toBeNull();
  });

  it("PO screenshot fix (2026-07-08): Vista cards show only the label — clicking a tab activates the preset with no question/description line rendered anywhere", async () => {
    setUrl("/gob/panorama?period=3y");
    renderRedesignConsole();

    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Señales de brote/ }));

    openVista();
    expect(screen.getByRole("radio", { name: /Señales de brote/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // Both the parent's duplicated "VISTA" headline + question line AND the
    // per-card description were removed — the preset's question never renders.
    expect(
      screen.queryByText("¿Dónde se registran señales de brote sobre huecos de vacunación?"),
    ).not.toBeInTheDocument();
  });
});

describe("PanoramaConsole — TimeScrubber temporal gating (panorama-vista-redesign Phase 4)", () => {
  it("non-temporal vista (cumplimiento: cobertura only) shows the scrubber's disabled state", async () => {
    setUrl("/gob/panorama?period=3y");
    renderRedesignConsole();
    await openTimeline();

    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /cumplimiento/i }));

    expect(
      screen.getByText(/La reproducción temporal necesita una capa de eventos activa/),
    ).toBeInTheDocument();
  });

  it("current-state base (brotes-activos: cobertura base): active scrubber carries the honest 'estado actual' disclaimer (trust/safety)", async () => {
    setUrl("/gob/panorama?period=3y");
    renderRedesignConsole();
    await openTimeline();

    // brotes-activos: base cobertura (current-state) + signal zoonosis (temporal)
    // → the scrubber stays active (zoonosis reproduces) but must state plainly
    // that the cobertura fill does not move with the fecha de corte.
    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Señales de brote/ }));

    expect(
      screen.queryByText(/La reproducción temporal necesita una capa de eventos activa/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/El indicador base \(cobertura antirrábica\) es un estado actual/),
    ).toBeInTheDocument();
  });

  it("activating a temporal layer self-enables the scrubber without a reload", async () => {
    setUrl("/gob/panorama?period=3y");
    renderRedesignConsole();
    await openTimeline();

    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /cumplimiento/i }));
    expect(
      screen.getByText(/La reproducción temporal necesita una capa de eventos activa/),
    ).toBeInTheDocument();
    // Task #38 v3: the layer catalog is the Filtro rail panel — FiltroPanel
    // renders the checkbox rows directly (LayerPanel is no longer mounted). P3.6:
    // the Simple/Detalle toggle was removed; the panel always shows full detail,
    // so just open it and click the zoonosis row's checkbox for real.
    openFiltro();

    // WP2 progressive disclosure: under the cumplimiento vista only its own
    // layers render by default — zoonosis sits behind the panel expander.
    fireEvent.click(screen.getByRole("button", { name: /Ver todas las capas/ }));

    // zoonosis is temporal — activating it must flip temporalAvailable true.
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox", { name: /Zoonosis/ }));
    });

    await waitFor(() => {
      expect(
        screen.queryByText(/La reproducción temporal necesita una capa de eventos activa/),
      ).not.toBeInTheDocument();
    });
  });
});

describe("PanoramaConsole — preset frame (camera-only)", () => {
  // Explicit period in the URL → the first-visit default preset stays out of
  // the way, so token counting starts at the test's own clicks.
  it("passes { framing, token } to the map when the preset carries framing", () => {
    setUrl("/gob/panorama?period=3y");
    renderRedesignConsole();

    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Señales de brote/ }));

    expect(mapProps?.frame).toEqual({ framing: { kind: "national" }, token: 1 });
  });

  it("re-clicking the SAME preset bumps the token so the map re-frames", () => {
    setUrl("/gob/panorama?period=3y");
    renderRedesignConsole();

    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Señales de brote/ }));
    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Señales de brote/ }));

    expect(mapProps?.frame).toEqual({ framing: { kind: "national" }, token: 2 });
  });

  it("clears the frame when a framing-less preset is selected (map behavior unchanged)", () => {
    setUrl("/gob/panorama?period=3y");
    renderRedesignConsole();

    // bienestar is a locality-level drill-down preset — deliberately framing-less
    // (design-QA 2026-07-04: only national-overview presets frame the country).
    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Señales de brote/ }));
    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Bienestar/ }));

    expect(mapProps?.frame).toBeNull();
  });
});

describe("PanoramaConsole — first-visit default preset (design-QA 2026-07-04 highest-leverage nit)", () => {
  it("default-activates 'bienestar' on a truly-bare first visit, aligned with fetch (QA #81)", async () => {
    // spyOn returns the SAME spy when history.pushState was already spied in a
    // previous test — clear its accumulated calls before this render.
    const pushSpy = vi.spyOn(window.history, "pushState");
    pushSpy.mockClear();
    renderRedesignConsole();

    // Board committed silently — replaceState, never a history entry.
    expect(pushSpy).not.toHaveBeenCalled();
    const params = new URLSearchParams(window.location.search);
    // QA histórico 2026-07-08: the default landing preset is now the
    // proven-populated welfare view (base denuncias + decomisos reference) so the
    // first paint shows data instead of the empty cobertura choropleth.
    expect(params.get("preset")).toBe("bienestar");
    expect(params.get("period")).toBe("90d");
    expect(params.get("layers")).toBe("denuncias,decomisos");
    // Preset row and map state are CONNECTED on first paint: the button reads
    // active. bienestar is a locality drill-down preset — deliberately
    // framing-less, so the map receives no national frame on the default land.
    openVista();
    expect(screen.getByRole("radio", { name: /Bienestar/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(mapProps?.frame).toBeNull();
    // The preset's base layer resolves client-side against the committed period.
    await waitFor(() => {
      const layerCalls = fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.startsWith("/api/panorama/") && !u.includes("/kpis"));
      expect(
        layerCalls.some((u) => u.includes("/api/panorama/denuncias") && u.includes("period=90d")),
      ).toBe(true);
    });
  });

  it("honors a role-aware defaultPresetId — govt lands on 'sintomas' (local surveillance)", async () => {
    // Audit-ratified 2026-07-09: a jurisdiction (govt) operator opens on local
    // syndromic surveillance instead of the national welfare default. The server
    // page passes the role-resolved preset; the console default-activates IT on a
    // truly-bare first visit (same URL-contract guard as the fallback).
    const pushSpy = vi.spyOn(window.history, "pushState");
    pushSpy.mockClear();
    renderRedesignConsole({ defaultPresetId: "sintomas" });

    expect(pushSpy).not.toHaveBeenCalled();
    const params = new URLSearchParams(window.location.search);
    expect(params.get("preset")).toBe("sintomas");
    expect(params.get("period")).toBe("30d");
    expect(params.get("layers")).toBe("zoonosis,sintomas");
    // sintomas is a locality-level drill-down preset — framing-less, so it stays
    // in the operator's jurisdiction (no national frame on the default land).
    expect(mapProps?.frame).toBeNull();
    await waitFor(() => {
      const layerCalls = fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.startsWith("/api/panorama/") && !u.includes("/kpis"));
      expect(
        layerCalls.some((u) => u.includes("/api/panorama/sintomas") && u.includes("period=30d")),
      ).toBe(true);
    });
  });

  it("does NOT default-activate when the URL carries an explicit period (deliberate navigation)", () => {
    setUrl("/gob/panorama?period=30d");
    renderRedesignConsole();

    const params = new URLSearchParams(window.location.search);
    expect(params.get("preset")).toBeNull();
    expect(params.get("layers")).toBeNull();
  });

  it("does NOT default-activate when a saved board exists (the restore wins)", async () => {
    window.localStorage.setItem(
      "panorama:board:v1",
      JSON.stringify({ layers: "denuncias", level: "locality", preset: null, period: "30d" }),
    );
    renderRedesignConsole();

    await waitFor(() => {
      const params = new URLSearchParams(window.location.search);
      expect(params.get("layers")).toBe("denuncias");
    });
    expect(new URLSearchParams(window.location.search).get("preset")).toBeNull();
  });
});

describe("PanoramaConsole — server-seeded first-visit fast path (perf plan 1.2)", () => {
  // A non-empty FeatureCollection per layer so a seeded layer read from the
  // WRONG cache (a level mismatch — C2) would surface as an EMPTY_FC on the map.
  const seedFc = (tag: string) => ({
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        properties: { tag },
        geometry: { type: "Point" as const, coordinates: [-58.4, -34.6] },
      },
    ],
  });
  const bienestarSeed = [
    {
      id: "denuncias",
      features: seedFc("denuncias"),
      truncated: false,
      suppressedCount: 0,
      noLocalityCount: 0,
    },
    {
      id: "decomisos",
      features: seedFc("decomisos"),
      truncated: false,
      suppressedCount: 0,
      noLocalityCount: 0,
    },
  ];

  it("paints the seeded preset layers on first render with NO live layer load and NO KPI refetch", async () => {
    const pushSpy = vi.spyOn(window.history, "pushState");
    pushSpy.mockClear();
    renderRedesignConsole({
      // PO-ratified 2026-07-09: a NATIONAL first visit seeds the role-default
      // preset (bienestar) at PROVINCE — the preset's own `level: "locality"` is
      // now only a preference; the scope (national here) decides. initialLevel
      // MUST equal that seed level (the C2 invariant), and the zoomed-out
      // hysteresis derivation lands on the same province, so there is no drift.
      seededPresetId: "bienestar",
      seededLayers: bienestarSeed,
      initialLevel: "province",
    });

    // The preset row + map connect on first paint (no fetch waited on).
    await waitFor(() => {
      openVista();
      expect(screen.getByRole("radio", { name: /Bienestar/ })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    });

    // The board committed silently (replaceState, not a history push) with the
    // preset's period + layers + locality level.
    expect(pushSpy).not.toHaveBeenCalled();
    const params = new URLSearchParams(window.location.search);
    expect(params.get("preset")).toBe("bienestar");
    expect(params.get("period")).toBe("90d");
    expect(params.get("layers")).toBe("denuncias,decomisos");
    // National framing → province is the derived level, so the board carries NO
    // explicit `level` flag (province is the un-flagged default).
    expect(params.get("level")).toBeNull();

    // The seeded features are on the map AT the seeded level — read from the
    // cache that matches initialLevel. A level mismatch would blank these
    // (EMPTY_FC), so a non-empty read IS the level-invariant guard.
    const layers = (mapProps?.layers ?? []) as Array<{
      id: string;
      features: { features: unknown[] };
    }>;
    const denuncias = layers.find((l) => l.id === "denuncias");
    const decomisos = layers.find((l) => l.id === "decomisos");
    expect(denuncias?.features.features.length).toBe(1);
    expect(decomisos?.features.features.length).toBe(1);
    // perdidas (the legacy default seed) is NOT on the board on this path.
    expect(layers.some((l) => l.id === "perdidas")).toBe(false);

    // The whole point: the preset commit issues NO LIVE layer load — every
    // seeded layer was served from the cache the initializer filled, so
    // fetchLayersInto has nothing to fetch (missingFromCache === []).
    //
    // NOTE on the scope of this assertion: we key on LIVE loads (asOf-absent).
    // Under THIS test's `useSearchParams` mock (which reads window.location), the
    // shallow board commit flips the resolved window 3y→90d, and the real
    // TimeScrubber transiently emits a non-live as-of on that transition — firing
    // a couple of `?asOf=` refetches. That is PRE-EXISTING scrubber behavior (it
    // happens on the non-seeded first-visit path too) and does NOT occur in
    // production, where useSearchParams ignores the History-API commit so the
    // window never transitions. It is orthogonal to this commit's caching win.
    const liveLayerCalls = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter(
        (u) =>
          u.startsWith("/api/panorama/") &&
          !u.includes("/kpis") &&
          !u.includes("asOf=") &&
          // The scrubber histogram (?histogram=1) is a separate scope-total call,
          // not a seeded-layer FEATURE load — this assertion guards the latter.
          !u.includes("histogram=1") &&
          // Same for the rule-change marker fetch: one tiny scope-keyed
          // audit-log read for the scrubber's marker layer, not a layer load.
          !u.includes("/rule-changes"),
      );
    const kpiCalls = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("/api/panorama/kpis"));
    expect(liveLayerCalls).toEqual([]);
    // The KPIs were seeded server-side at the preset window; seededQsRef is
    // pre-armed with the committed scope+period so the commit skips the refetch.
    expect(kpiCalls).toEqual([]);
  });
});

describe("PanoramaConsole — debounce + keyed abort (panorama-redesign Fase 1)", () => {
  const coberturaCalls = () =>
    fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/panorama/cobertura"));

  it("coalesces rapid preset clicks into ONE fetch burst for the last selection", async () => {
    renderRedesignConsole();

    // Two clicks inside the 200ms debounce window: only the LAST preset fetches.
    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Señales de brote/ }));
    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /cumplimiento/i }));

    await waitFor(() => expect(coberturaCalls()).toHaveLength(1));
    // brotes-activos' zoonosis layer was superseded before its burst fired. The
    // scrubber histogram (?histogram=1) is a separate scope-total call, not the
    // superseded FEATURE fetch this test guards.
    const zoonosisCalls = fetchMock.mock.calls.filter(
      (c) =>
        String(c[0]).includes("/api/panorama/zoonosis") && !String(c[0]).includes("histogram=1"),
    );
    expect(zoonosisCalls).toHaveLength(0);
  });

  it("aborts a superseded in-flight fetch; the abort NEVER deactivates the layer; last click wins", async () => {
    deferMode = true;
    renderRedesignConsole();
    // Task #38 v3: the layer catalog is the Filtro rail panel — FiltroPanel
    // renders the cobertura row's checkbox + live loading/count spans directly
    // (LayerPanel is no longer mounted). P3.6: no Simple/Detalle toggle; full
    // detail always shows, so just open the panel.
    openFiltro();

    // Burst A (brotes-activos): cobertura + zoonosis go in flight after ~200ms.
    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Señales de brote/ }));
    await waitFor(() => expect(coberturaCalls()).toHaveLength(1));

    // Burst B (cumplimiento) supersedes A's cobertura fetch.
    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /cumplimiento/i }));
    await waitFor(() => expect(coberturaCalls()).toHaveLength(2));

    const [first, second] = coberturaCalls();
    expect((first[1]?.signal as AbortSignal).aborted).toBe(true);
    expect((second[1]?.signal as AbortSignal).aborted).toBe(false);

    // Let A's AbortError rejection settle: the catch must EARLY-RETURN — the
    // layer stays active+loading (B in flight), never flipped to inactive.
    // Selecting a preset closes the rail panel (task #38 v3) — reopen Filtro
    // to read the row's live state (the underlying `states` is console state,
    // unaffected by the panel remounting).
    await act(async () => {});
    openFiltro();
    const coberturaCheckbox = screen.getByRole("checkbox", {
      name: /Cobertura antirrábica/,
    }) as HTMLInputElement;
    const coberturaRow = coberturaCheckbox.closest("label") as HTMLElement;
    expect(coberturaCheckbox.checked).toBe(true);
    expect(within(coberturaRow).getByText("cargando…")).toBeInTheDocument();

    // Resolve the WINNING (last) fetch — its payload lands.
    const point = {
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [-60, -35] as [number, number] },
      properties: {},
    };
    const winning = deferred.filter((d) => d.url.includes("/api/panorama/cobertura")).at(-1);
    expect(winning).toBeDefined();
    act(() => {
      winning!.resolve({
        features: { type: "FeatureCollection", features: [point, point] },
        truncated: false,
        suppressedCount: 0,
        noLocalityCount: 0,
      });
    });

    await waitFor(() => {
      expect(within(coberturaRow).queryByText("cargando…")).not.toBeInTheDocument();
      expect(coberturaCheckbox.checked).toBe(true);
      expect(within(coberturaRow).getByText("2")).toBeInTheDocument();
    });
  });
});

describe("PanoramaConsole — implicit single-province division scope (PO validation 2026-07-07)", () => {
  it("threads the implicit division province to the map when no ?province is selected (scoped govt operator)", () => {
    // A CABA operator lands on /gob/panorama already scoped to CABA but never
    // picks a province in the switcher, so ?province is absent. The console must
    // still hand the map the effective province so its 48 barrios render.
    setUrl("/gob/panorama?period=3y");
    render(
      <PanoramaConsole
        defaultLayerId="perdidas"
        defaultFeatures={EMPTY_FC}
        initialKpis={INITIAL_KPIS}
        initialLevel="locality"
        initialDivisionProvince="AR-C"
      />,
    );

    expect(mapProps?.selectedProvinceCode).toBe("AR-C");
  });

  it("also activates the implicit province on a truly-bare first visit (no explicit board)", () => {
    // The real scenario: the operator opens the panorama fresh. The first-visit
    // default preset still fires, but it never sets ?province, so the effective
    // province must persist through it.
    setUrl("/gob/panorama");
    render(
      <PanoramaConsole
        defaultLayerId="perdidas"
        defaultFeatures={EMPTY_FC}
        initialKpis={INITIAL_KPIS}
        initialLevel="locality"
        initialDivisionProvince="AR-C"
      />,
    );

    expect(mapProps?.selectedProvinceCode).toBe("AR-C");
  });

  it("keeps the national basemap (null province) when there is no implicit scope (admin/multi-province)", () => {
    setUrl("/gob/panorama?period=3y");
    render(
      <PanoramaConsole
        defaultLayerId="perdidas"
        defaultFeatures={EMPTY_FC}
        initialKpis={INITIAL_KPIS}
      />,
    );

    expect(mapProps?.selectedProvinceCode).toBeNull();
  });

  it("lets an explicit ?province selection win over the implicit scope (explicit path intact — admin drill-down too)", () => {
    // Admin (or a multi-province operator) explicitly picking a province, or a
    // scoped operator overriding their home province, must render THAT province.
    setUrl("/gob/panorama?period=3y&province=AR-B");
    render(
      <PanoramaConsole
        defaultLayerId="perdidas"
        defaultFeatures={EMPTY_FC}
        initialKpis={INITIAL_KPIS}
        initialLevel="locality"
        initialDivisionProvince="AR-C"
      />,
    );

    expect(mapProps?.selectedProvinceCode).toBe("AR-B");
  });
});

describe("PanoramaConsole — derived aggregation level (A2: province by default, departments reveal past Z_DIVISIONS)", () => {
  it("KEEPS the province axis when the camera zooms past Z_LOCALITY but BELOW Z_DIVISIONS at national scope", async () => {
    renderConsole();
    // Activate a province-baseline preset with a choropleth base (cobertura).
    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Señales de brote/ }));
    await waitFor(() => {
      expect(mapProps?.onZoom).toBeInstanceOf(Function);
    });
    fetchMock.mockClear();

    // Zoom past Z_LOCALITY (5) but below the department-reveal threshold
    // Z_DIVISIONS (6.5) — the map reports the new camera zoom.
    act(() => {
      (mapProps!.onZoom as (z: number) => void)(6);
    });

    // A2: below Z_DIVISIONS the clean province overview stays — free zoom is
    // LOOKING, and departments only reveal PAST the threshold. NO nationwide
    // locality refetch fires here (the department fill starts at 6.5).
    const coberturaCalls = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("/api/panorama/cobertura"));
    expect(coberturaCalls.length).toBe(0);
  });

  it("FLIPS to the locality (department) axis when the camera zooms PAST Z_DIVISIONS at national scope (A2)", async () => {
    renderConsole();
    // A choropleth base (cobertura) is active — the metric that fills the departments.
    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Señales de brote/ }));
    await waitFor(() => {
      expect(mapProps?.onZoom).toBeInstanceOf(Function);
    });
    fetchMock.mockClear();

    // Zoom PAST Z_DIVISIONS (6.5) — automatic department-grain LOD kicks in.
    act(() => {
      (mapProps!.onZoom as (z: number) => void)(7);
    });

    // A2: departments fill automatically with the active metric — the data axis
    // flips to locality and a department-grain (cube-served) cobertura refetch
    // fires. The request carries NO `level=province` flag (locality is the
    // un-flagged default → the server's cube national+department path).
    await waitFor(() => {
      const coberturaCalls = fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.includes("/api/panorama/cobertura"));
      expect(coberturaCalls.length).toBeGreaterThan(0);
      expect(coberturaCalls.every((u) => !u.includes("level=province"))).toBe(true);
    });
  });

  it("keeps PROVINCE at national scope while the camera stays below Z_LOCALITY", async () => {
    renderConsole();
    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Señales de brote/ }));
    await waitFor(() => {
      expect(mapProps?.onZoom).toBeInstanceOf(Function);
    });
    fetchMock.mockClear();

    // A far-out zoom must NOT trigger a locality refetch (level stays province).
    act(() => {
      (mapProps!.onZoom as (z: number) => void)(3.5);
    });

    // No new cobertura fetch is issued — the level did not change.
    const coberturaCalls = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("/api/panorama/cobertura"));
    expect(coberturaCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// QA fixes (cursor-agent review, panorama-vista-redesign)
// ---------------------------------------------------------------------------

describe("PanoramaConsole — scrubber temporal-gating cluster (QA fix)", () => {
  it("clears asOf and undims non-temporal layers once the active set loses its last temporal layer (finding 1)", async () => {
    setUrl("/gob/panorama?period=3y");
    renderRedesignConsole();
    await openTimeline();

    // brotes-activos: base cobertura (non-temporal) + signal zoonosis (temporal).
    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Señales de brote/ }));
    // Task #38 v3: the layer catalog is the Filtro rail panel — FiltroPanel
    // renders the checkbox rows directly (LayerPanel is no longer mounted). P3.6:
    // no Simple/Detalle toggle; full detail always shows.
    openFiltro();

    // Start a scrub — the loop chip is enabled as soon as zoonosis is active
    // (activation is synchronous; it doesn't wait on the layer fetch).
    await waitFor(
      () => {
        expect(screen.getByRole("button", { name: "↺ última semana" })).toBeEnabled();
      },
      { timeout: 10_000 },
    );
    fireEvent.click(screen.getByRole("button", { name: "↺ última semana" }));
    await waitFor(
      () => {
        const cobertura = (mapProps?.layers as Array<{ id: string; dimmed?: boolean }>)?.find(
          (l) => l.id === "cobertura",
        );
        expect(cobertura?.dimmed).toBe(true);
      },
      { timeout: 10_000 },
    );

    // Deactivate the only temporal layer — temporalAvailable flips false. The
    // Filtro panel is still open/Detalle (nothing since closed it), so the
    // zoonosis checkbox (checked, activated above) is reachable directly.
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox", { name: /Zoonosis/ }));
    });

    // MEASURED 2026-08-10 — read this before bumping the number again.
    //
    // This wait has been raised twice (dc255915, 5a3f9963) on the theory of "a
    // slow state flush". That theory is wrong, and the bisect says so:
    //
    //   `vitest run --project db`  → 686 files, 6985 tests, PASS (1 of 1)
    //   `pnpm test` (full suite)   → this assertion FAILS (2 of 2)
    //
    // The db project is serial by design. The unit project is not, and the two
    // run CONCURRENTLY — so while this file holds the serial lane, N unit
    // workers saturate the machine. This is the heaviest file in the suite
    // (103 tests, ~24s) and it is the one that starves. Nothing about the
    // component is slow; it is not getting scheduled.
    //
    // THE STRUCTURAL FIX LANDED (PO decision, 2026-08-10): vitest.config.ts now
    // gives the two projects `sequence.groupOrder` 0 and 1, so `unit` finishes
    // before `db` starts and nothing contends with the serial lane.
    //
    // The 30s stays as belt-and-braces on the heaviest file in the suite, but it
    // is no longer load-bearing. If this ever goes red again, do NOT raise it a
    // fourth time — the timeout was never the lever. Check the group order
    // first.
    await waitFor(
      () => {
        expect(
          screen.getByText(/La reproducción temporal necesita una capa de eventos activa/),
        ).toBeInTheDocument();
      },
      { timeout: 30_000 },
    );
    // The map must stop dimming cobertura — asOf was cleared, not left stuck.
    await waitFor(
      () => {
        const cobertura = (mapProps?.layers as Array<{ id: string; dimmed?: boolean }>)?.find(
          (l) => l.id === "cobertura",
        );
        expect(cobertura?.dimmed).toBe(false);
      },
      { timeout: 30_000 },
    );
    // THE TEST BOUND MUST EXCEED THE SUM OF ITS OWN waitFor BUDGETS, and 15_000
    // did not: the four explicit budgets above total 80s (10+10+30+30), so under
    // a saturated full-suite run the earlier waits can legitimately spend the
    // whole bound while PASSING, and what fails first is the test itself with a
    // bare "Exceeded timeout" instead of a waitFor's own message — the exact
    // inversion this file's header rules out ("waitFor bounds itself and fails
    // first"). Measured 2026-08-31: two test:verified runs over one tree
    // answered 1-failing / 0-failing on this test, dying at 15012 ms against
    // 15000 — the sixth instance of the wall-clock-under-load class, and the
    // second whose two ceilings left no margin for each other (the first was
    // PetPhotoScreen at 5000/5000). 90s = the 80s worst case plus margin; it is
    // only ever paid on a genuine failure, never on a pass — a passing run
    // settles in seconds and the docblock above explains why the 30s budgets
    // themselves must not be touched.
    //
    // 2026-09-01, THE ACTUAL CAUSE, found when gate C's two runs answered
    // differently and the legible failure ("the notice NEVER appeared") could
    // finally be diagnosed: applyPreset's 200ms debounced fetch resolved AFTER
    // this test's uncheck and its success arm wrote `active: true`
    // unconditionally — resurrecting zoonosis, so `temporalAvailable` never
    // flipped and the notice never rendered. Not slowness, a real product
    // race (an operator unchecking a layer during its vista's spinner had the
    // checkbox re-check itself). Guarded at every async success arm in
    // PanoramaConsole.tsx ("the operator's deactivation outranks a fetch that
    // was in flight"), which makes both interleavings of this test's window
    // converge on the same outcome. A deterministic repro via deferMode was
    // attempted and hit a harness wall worth recording: a newly-activated
    // layer's Filtro row only MOUNTS once its fetch resolves, so the uncheck
    // cannot be delivered while the racing fetch is held open — the row to
    // click does not exist yet. If someone wants the deterministic pin, the
    // seam is a second fetch for an ALREADY-cached layer (row persists), held
    // open while unchecking.
  }, 90_000);

  it("keyed-aborts a superseded as-of fetch on a rapid scrub (finding 4)", async () => {
    deferMode = true;
    setUrl("/gob/panorama?period=3y");
    renderRedesignConsole();
    await openTimeline();

    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Señales de brote/ }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "↺ última semana" })).toBeEnabled();
    });

    // Two rapid loop-chip clicks each move the scrub position, firing two
    // as-of fetches for the active temporal layer (zoonosis).
    fireEvent.click(screen.getByRole("button", { name: "↺ última semana" }));
    fireEvent.click(screen.getByRole("button", { name: "↺ último mes" }));

    await waitFor(() => {
      const asOfCalls = deferred.filter(
        (d) => d.url.includes("/api/panorama/zoonosis") && d.url.includes("asOf="),
      );
      expect(asOfCalls.length).toBeGreaterThanOrEqual(2);
    });
    const asOfCalls = deferred.filter(
      (d) => d.url.includes("/api/panorama/zoonosis") && d.url.includes("asOf="),
    );
    const [first, second] = asOfCalls.slice(-2);
    expect(first.signal?.aborted).toBe(true);
    expect(second?.signal?.aborted).toBe(false);
  });
});

describe("PanoramaConsole — province-level scrub paints the as-of frame (CRITICAL-2)", () => {
  it("fetches the as-of frame at level=province when scrubbing at province framing", async () => {
    setUrl("/gob/panorama?period=3y");
    renderRedesignConsole();
    await openTimeline();

    // brotes-activos at national scope → province is the derived level; zoonosis
    // (temporal) is active.
    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Señales de brote/ }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "↺ última semana" })).toBeEnabled();
    });
    fetchMock.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "↺ última semana" }));

    // The zoonosis as-of fetch now carries the province level flag, so the frame
    // matches the province-aggregated map. Before the fix it fetched locality-level
    // and the province map silently kept painting the LIVE cache.
    await waitFor(() => {
      const asOfCalls = fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.includes("/api/panorama/zoonosis") && u.includes("asOf="));
      expect(asOfCalls.length).toBeGreaterThan(0);
      expect(asOfCalls.every((u) => u.includes("level=province"))).toBe(true);
    });
  });

  it("renders the as-of frame as the zoonosis data source (not the live province cache)", async () => {
    // Distinct payloads: the province-level as-of zoonosis returns ONE feature;
    // every other fetch stays empty. If the reorder is correct, the map's zoonosis
    // layer carries that as-of feature while scrubbing.
    const asOfFeature = {
      type: "Feature" as const,
      properties: { provinceCode: "AR-B", value: 42 },
      geometry: { type: "Point" as const, coordinates: [-60, -36] },
    };
    const custom = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      const isAsOfZoonosisProvince =
        url.includes("/api/panorama/zoonosis") &&
        url.includes("asOf=") &&
        url.includes("level=province");
      const body = url.includes("/api/panorama/kpis")
        ? INITIAL_KPIS
        : isAsOfZoonosisProvince
          ? { features: { type: "FeatureCollection", features: [asOfFeature] }, truncated: false }
          : OK_ENVELOPE;
      return Promise.resolve({ ok: true, json: async () => body } as unknown as Response);
    });
    vi.stubGlobal("fetch", custom);

    setUrl("/gob/panorama?period=3y");
    renderRedesignConsole();
    await openTimeline();
    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Señales de brote/ }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "↺ última semana" })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole("button", { name: "↺ última semana" }));

    await waitFor(() => {
      const zoonosis = (
        mapProps?.layers as Array<{ id: string; features: { features: unknown[] } }>
      )?.find((l) => l.id === "zoonosis");
      expect(zoonosis?.features.features.length).toBe(1);
    });
  });
});

describe("PanoramaConsole — bivariate is honest under a scrub (CRITICAL-2)", () => {
  it("disables the bivariate encoding while scrubbing and shows an honest note", async () => {
    setUrl("/gob/panorama?period=3y");
    renderRedesignConsole();
    await openTimeline();

    // brotes-activos + province level + cobertura & zoonosis active → the encoding
    // toggle is offered.
    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Señales de brote/ }));
    const bivariateBtn = await screen.findByRole("button", {
      name: "Intensidad de reporte (bivariado)",
    });
    expect(bivariateBtn).toBeEnabled();

    // Start a scrub — cobertura is non-temporal (frozen), so a bivariate join would
    // mix time bases. The encoding must be disabled with an honest caption.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "↺ última semana" })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "↺ última semana" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Intensidad de reporte (bivariado)" }),
      ).toBeDisabled();
    });
    expect(screen.getByText(/solo al último evento/i)).toBeInTheDocument();
  });
});

describe("PanoramaConsole — reading aligned with the metrics column (QA fix, finding 5)", () => {
  it("PanoramaReading headlines only the active preset's curated metrics, not the full KPI set", async () => {
    setUrl("/gob/panorama?period=3y");
    const customKpis = {
      kpis: [
        {
          id: "cobertura" as const,
          label: "Cobertura antirrábica",
          value: "10%",
          tone: "neutral" as const,
          info: { definition: "d" },
          href: "/x",
          source: "s",
          delta: { pct: 50, unit: "pct" as const, direction: "down" as const, label: "-50%" },
        },
        {
          id: "mordeduras" as const,
          label: "Mordeduras / 10k hab.",
          value: "3",
          tone: "neutral" as const,
          info: { definition: "d" },
          href: "/x",
          source: "s",
          delta: { pct: 5, unit: "pct" as const, direction: "up" as const, label: "+5%" },
        },
      ],
      recalculatedFor: "Recalculado para Nacional",
      dataAsOf: null,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        const body = url.includes("/api/panorama/kpis") ? customKpis : OK_ENVELOPE;
        return Promise.resolve({ ok: true, json: async () => body } as unknown as Response);
      }),
    );

    render(
      <PanoramaConsole
        defaultLayerId="perdidas"
        defaultFeatures={EMPTY_FC}
        initialKpis={customKpis}
      />,
    );

    // bienestar's curated metrics are denuncias/mordeduras — cobertura
    // (the larger-magnitude delta) is excluded. The full-kpis reading would
    // headline cobertura; the aligned reading must headline mordeduras instead.
    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Bienestar/ }));

    await waitFor(() => {
      expect(screen.getByText(/Mordeduras empeora 5%/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Cobertura antirrábica empeora/)).not.toBeInTheDocument();
  });
});

describe("PanoramaConsole — saved-board Simple/Detalle strict boolean coercion (QA fix, finding 7)", () => {
  it("reads a corrupt non-boolean capasDetail/scrubDetail as Simple, never as truthy", async () => {
    window.localStorage.setItem(
      "panorama:board:v1",
      JSON.stringify({
        layers: "cobertura",
        level: "province",
        preset: null,
        period: "90d",
        capasDetail: "yes", // corrupt: not a boolean
        scrubDetail: 1, // corrupt: not a boolean
      }),
    );

    expect(() => renderConsole()).not.toThrow();

    await waitFor(() => {
      const params = new URLSearchParams(window.location.search);
      expect(params.get("layers")).toBe("cobertura");
    });
    // P3.6: the Capas Simple/Detalle toggle was removed — a corrupt saved
    // capasDetail/scrubDetail must still restore without crashing (it is coerced
    // and kept for persistence continuity), and no Simple/Detalle button mounts.
    openFiltro();
    expect(
      screen.queryByRole("button", { name: "Modo simple de Capas del mapa" }),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// perf plan 1.3 — streamed (un-awaited) KPIs: pending → resolved + last-set-wins
// ---------------------------------------------------------------------------

/** An externally-controllable promise, mirroring the RSC-streamed KPI loader. */
function deferredPromise<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const MORDEDURAS_KPIS: PanoramaKpis = {
  kpis: [
    {
      id: "mordeduras",
      label: "Mordeduras / 10k hab.",
      value: "1,2",
      tone: "warn",
      info: { definition: "d" },
      href: "/gob/vigilancia",
      source: "s",
    },
  ],
  recalculatedFor: "Recalculado para Nacional",
  dataAsOf: null,
  coverageDenominator: null,
};

describe("PanoramaConsole — streamed KPIs (perf plan 1.3)", () => {
  it("renders the 'Cargando indicadores…' pending state while the promise is unresolved, then the KPI once it lands", async () => {
    // Explicit period so the console does NOT rewrite the board on mount (no
    // preset auto-activation), keeping the strip in manual mode (shows all KPIs).
    setUrl("/gob/panorama?period=3y");
    const { promise, resolve } = deferredPromise<PanoramaKpis>();

    render(
      <PanoramaConsole
        defaultLayerId="perdidas"
        defaultFeatures={EMPTY_FC}
        kpisPromise={promise}
      />,
    );

    // Pending: the metrics column shows the loading cue, not a KPI or the
    // degraded "no disponibles" copy.
    expect(screen.getByText("Cargando indicadores…")).toBeInTheDocument();
    expect(screen.queryByText("Mordeduras / 10k hab.")).not.toBeInTheDocument();

    await act(async () => {
      resolve(MORDEDURAS_KPIS);
      await promise;
    });

    // Resolved: the pending cue is gone. C2a — in manual mode the mordeduras KPI
    // does NOT describe the active perdidas layer, so it starts hidden behind the
    // "Ver todos los indicadores" toggle (an indicator never headlines over a
    // layer it doesn't measure); revealing it proves the streamed KPI landed.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Ver todos los indicadores/ })).toBeInTheDocument();
    });
    expect(screen.queryByText("Cargando indicadores…")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Ver todos los indicadores/ }));
    expect(screen.getByText("Mordeduras / 10k hab.")).toBeInTheDocument();
  });

  it("last-set-wins: a client refetch that takes over is NOT clobbered by the late-resolving streamed seed", async () => {
    setUrl("/gob/panorama?period=3y");
    const { promise: seedPromise, resolve: resolveSeed } = deferredPromise<PanoramaKpis>();

    const view = render(
      <PanoramaConsole
        defaultLayerId="perdidas"
        defaultFeatures={EMPTY_FC}
        kpisPromise={seedPromise}
      />,
    );

    // Flush mount effects — the seed effect subscribes; the strip is pending.
    await act(async () => {});
    expect(screen.getByText("Cargando indicadores…")).toBeInTheDocument();

    // Change the period → scopePeriodQs changes → the client KPI refetch effect
    // issues (fetchMock returns the empty INITIAL_KPIS) and takes over the strip.
    setUrl("/gob/panorama?period=90d");
    await act(async () => {
      view.rerender(
        <PanoramaConsole
          defaultLayerId="perdidas"
          defaultFeatures={EMPTY_FC}
          kpisPromise={seedPromise}
        />,
      );
    });

    // The client refetch resolved to an EMPTY strip (no tiles) and cleared the
    // pending state — an empty settled strip now reads as a FAILURE state, never
    // an all-clear (empty ≠ all-clear, fix #1), so the metrics column shows the
    // degraded copy, not loading and not a reassuring "no disponibles".
    await waitFor(() => {
      expect(
        screen.getByText("No pudimos cargar los indicadores en este momento."),
      ).toBeInTheDocument();
    });

    // NOW the slow streamed seed resolves LATE with a stale payload. The guard
    // must skip it — the seed's KPI must never appear over the fresher refetch.
    await act(async () => {
      resolveSeed(MORDEDURAS_KPIS);
      await seedPromise;
    });

    expect(screen.queryByText("Mordeduras / 10k hab.")).not.toBeInTheDocument();
    expect(
      screen.getByText("No pudimos cargar los indicadores en este momento."),
    ).toBeInTheDocument();
  });
});

describe("PanoramaConsole — embedded scope drill (Theme 1: no reload)", () => {
  const mockAssign = vi.fn();
  const originalLocation = window.location;

  function stubLocation(url: string) {
    const u = new URL(url, "http://localhost");
    // jsdom's real location.assign is unspyable + throws on navigation — swap in
    // a stub exposing the fields the drill callbacks read plus a spyable assign.
    // pathname/search are the live URL the console reads via window.location.
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { ...originalLocation, pathname: u.pathname, search: u.search, assign: mockAssign },
    });
  }

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
    mockAssign.mockClear();
  });

  it("drills into a clicked province via SHALLOW pushState (no reload), reusing ?province + clearing locality/camera", async () => {
    setUrl("/gob/panorama?period=3y");
    render(
      <PanoramaConsole
        defaultLayerId="perdidas"
        defaultFeatures={EMPTY_FC}
        initialKpis={INITIAL_KPIS}
      />,
    );
    expect(mapProps?.onProvinceDrill).toBeInstanceOf(Function);
    // No explicit province yet → no "← Volver".
    expect(mapProps?.onReturnNational).toBeUndefined();

    // A national camera is pinned in the URL (z/lat/lng) — the drill must DROP it
    // so the drilled province frames itself instead of restoring the national camera.
    stubLocation("/gob/panorama?period=3y&locality=stale&z=4.2&lat=-38&lng=-63");
    // Real pushState would fight the stubbed location; assert the call, no side effect.
    const pushSpy = vi.spyOn(window.history, "pushState").mockImplementation(() => {});
    pushSpy.mockClear();
    mockAssign.mockClear();

    await act(async () => {
      (mapProps!.onProvinceDrill as (code: string) => void)("AR-B");
    });

    // The scope committed via the shallow History API — NOT a reload, NOT the
    // router. (Other shallow URL-sync writes — level/board — also go through the
    // History API; the contract that matters is the scope commit + no reload.)
    expect(mockAssign).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
    expect(routerReplace).not.toHaveBeenCalled();
    const drillPush = pushSpy.mock.calls
      .map((c) => new URL(c[2] as string, "http://localhost"))
      .find((u) => u.searchParams.get("province") === "AR-B");
    expect(drillPush).toBeDefined();
    expect(drillPush!.pathname).toBe("/gob/panorama");
    expect(drillPush!.searchParams.get("period")).toBe("3y");
    expect(drillPush!.searchParams.get("locality")).toBeNull();
    // Camera dropped — the province fit re-frames the map in place.
    expect(drillPush!.searchParams.get("z")).toBeNull();
    expect(drillPush!.searchParams.get("lat")).toBeNull();
    expect(drillPush!.searchParams.get("lng")).toBeNull();
    // The drilled province flows to the map immediately (no reload needed) so the
    // A1 autozoom + division rendering fire for AR-B.
    expect(mapProps?.selectedProvinceCode).toBe("AR-B");
    // A scope-bundle fetch was issued to refresh the switcher localities/centroids.
    await waitFor(() => {
      const scopeCalls = fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.includes("/api/panorama/scope"));
      expect(scopeCalls.some((u) => u.includes("province=AR-B"))).toBe(true);
    });
    pushSpy.mockRestore();
  });

  it("falls back to a full document navigation when the scope-bundle fetch fails (graceful degrade)", async () => {
    setUrl("/gob/panorama?period=3y");
    // A scope fetch that fails must degrade to today's behavior (full reload),
    // never a half-updated map.
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const u = String(input);
        if (u.includes("/api/panorama/scope")) {
          return Promise.resolve({ ok: false, status: 503 } as Response);
        }
        const body = u.includes("/api/panorama/kpis") ? INITIAL_KPIS : OK_ENVELOPE;
        return Promise.resolve({ ok: true, json: async () => body } as unknown as Response);
      }),
    );
    render(
      <PanoramaConsole
        defaultLayerId="perdidas"
        defaultFeatures={EMPTY_FC}
        initialKpis={INITIAL_KPIS}
      />,
    );
    stubLocation("/gob/panorama?period=3y");
    const pushSpy = vi.spyOn(window.history, "pushState").mockImplementation(() => {});
    pushSpy.mockClear();
    mockAssign.mockClear();

    await act(async () => {
      (mapProps!.onProvinceDrill as (code: string) => void)("AR-B");
    });

    await waitFor(() => {
      expect(mockAssign).toHaveBeenCalledTimes(1);
    });
    const url = new URL(mockAssign.mock.calls[0][0] as string, "http://localhost");
    expect(url.searchParams.get("province")).toBe("AR-B");
    pushSpy.mockRestore();
  });

  it("does NOT offer a drill or return to a jurisdiction-scoped operator", () => {
    setUrl("/gob/panorama?period=3y");
    render(
      <PanoramaConsole
        defaultLayerId="perdidas"
        defaultFeatures={EMPTY_FC}
        initialKpis={INITIAL_KPIS}
        initialDivisionProvince="AR-C"
      />,
    );
    expect(mapProps?.onProvinceDrill).toBeUndefined();
    expect(mapProps?.onReturnNational).toBeUndefined();
  });

  it("offers ← Volver for an explicit province pick and pops back to national via pushState (no reload)", async () => {
    setUrl("/gob/panorama?period=3y&province=AR-B");
    render(
      <PanoramaConsole
        defaultLayerId="perdidas"
        defaultFeatures={EMPTY_FC}
        initialKpis={INITIAL_KPIS}
      />,
    );
    expect(mapProps?.onReturnNational).toBeInstanceOf(Function);

    stubLocation("/gob/panorama?period=3y&province=AR-B&z=7.1&lat=-36&lng=-59");
    const pushSpy = vi.spyOn(window.history, "pushState").mockImplementation(() => {});
    pushSpy.mockClear();
    mockAssign.mockClear();

    await act(async () => {
      (mapProps!.onReturnNational as () => void)();
    });

    // Popped back to national with NO reload — a shallow History commit only.
    expect(pushSpy).toHaveBeenCalled();
    expect(mockAssign).not.toHaveBeenCalled();
    // The commit that dropped the province (and its camera) so national re-frames.
    const returnPush = pushSpy.mock.calls
      .map((c) => new URL(c[2] as string, "http://localhost"))
      .find((u) => u.searchParams.get("province") === null);
    expect(returnPush).toBeDefined();
    expect(returnPush!.searchParams.get("period")).toBe("3y");
    expect(returnPush!.searchParams.get("z")).toBeNull();
    expect(returnPush!.searchParams.get("lat")).toBeNull();
    expect(returnPush!.searchParams.get("lng")).toBeNull();
    // Return-to-national needs no scope-bundle fetch.
    expect(
      fetchMock.mock.calls.map((c) => String(c[0])).some((u) => u.includes("/api/panorama/scope")),
    ).toBe(false);
    // The map immediately returns to the national basemap (no province).
    expect(mapProps?.selectedProvinceCode).toBeNull();
    pushSpy.mockRestore();
  });

  it("browser Back (popstate) reverts a drill: scope follows the POPPED URL, no reload", async () => {
    setUrl("/gob/panorama?period=3y");
    render(
      <PanoramaConsole
        defaultLayerId="perdidas"
        defaultFeatures={EMPTY_FC}
        initialKpis={INITIAL_KPIS}
      />,
    );

    // Drill into AR-B — the map reflects the drilled province (client-committed).
    stubLocation("/gob/panorama?period=3y");
    const pushSpy = vi.spyOn(window.history, "pushState").mockImplementation(() => {});
    pushSpy.mockClear();
    mockAssign.mockClear();
    await act(async () => {
      (mapProps!.onProvinceDrill as (code: string) => void)("AR-B");
    });
    expect(mapProps?.selectedProvinceCode).toBe("AR-B");

    // Browser Back: the popped history entry is the national URL. A native
    // popstate does NOT re-sync useSearchParams in this Next version, so the
    // console must read the POPPED URL straight off window.location and revert
    // the client-committed scope — otherwise URL and view diverge (the bug).
    stubLocation("/gob/panorama?period=3y"); // national again — no ?province
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    // Scope tracks the popped URL (national) — no divergence, no full reload.
    expect(mapProps?.selectedProvinceCode).toBeNull();
    expect(mockAssign).not.toHaveBeenCalled();
    pushSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Live-QA regressions (2026-07-11): parts of the console still read the SERVER
// scope/level instead of the client drill state — the map prop is already
// client-wired, but the masthead pill was a byte-static server string and the
// level leaked across drill→Back. These tests reproduce each and pin the fix.
// ---------------------------------------------------------------------------
describe("PanoramaConsole — embedded drill: masthead pill + level reset (live-QA regressions)", () => {
  // The pages hand the console a `scopeLabel` (server default) + `allowedProvinces`.
  // Passing both mounts the masthead header (pill) AND the embedded switcher.
  function renderScopedConsole(extraProps: Record<string, unknown> = {}) {
    return render(
      <PanoramaConsole
        defaultLayerId="perdidas"
        defaultFeatures={EMPTY_FC}
        initialKpis={INITIAL_KPIS}
        scopeLabel="Nacional · todas las provincias"
        allowedProvinces={[
          { code: "AR-B", name: "Buenos Aires" },
          { code: "AR-C", name: "Ciudad Autónoma de Buenos Aires" },
        ]}
        {...extraProps}
      />,
    );
  }

  it("C.4: the scope pill NAMES THE ACT, so it reads as a control and not a status label", () => {
    // The pill is the operator's only entry point to the province → locality
    // drill, and the panel behind it starts closed. It used to render
    // "◉ <jurisdictions> ▾" with the word "Alcance" sr-only: assistive tech
    // heard a named control while a sighted operator saw a VALUE. That gap is
    // what the review called "no visible way to drill" — the affordance was
    // real and announced itself as a label. PO decision 2026-07-29: keep the
    // panel closed, make the chip read as a control.
    setUrl("/gob/panorama?period=3y");
    renderScopedConsole();

    const pill = screen.getByTestId("panorama-scope-pill");

    // The verb is present for BOTH audiences: visibly next to the caret, and
    // leading the accessible name.
    expect(pill).toHaveTextContent(/Cambiar/);
    expect(pill).toHaveTextContent(/Cambiar alcance\. Actualmente:/);

    // ...and it still says WHERE it currently is. Naming the act must not cost
    // the operator the state — the scope filters everything on this screen.
    expect(pill).toHaveTextContent(/Nacional/);
  });

  it("MEDIUM: the masthead pill re-labels to the drilled province on a client drill (was stuck on the server scopeLabel)", async () => {
    setUrl("/gob/panorama?period=3y");
    renderScopedConsole();

    // National at first paint — the pill shows the server default.
    expect(screen.getByTestId("panorama-scope-pill")).toHaveTextContent(
      "Nacional · todas las provincias",
    );

    // Drill into Buenos Aires via the SHALLOW client commit (no reload). Mock
    // pushState so window.location stays national — the pill must track the
    // client scopeOverride, NOT the URL/server value.
    const pushSpy = vi.spyOn(window.history, "pushState").mockImplementation(() => {});
    await act(async () => {
      (mapProps!.onProvinceDrill as (code: string) => void)("AR-B");
    });

    // The pill now names the drilled province (from the SAME client scope the
    // map/KPIs read), and the national default is gone.
    const pill = screen.getByTestId("panorama-scope-pill");
    expect(pill).toHaveTextContent("Buenos Aires");
    expect(pill).not.toHaveTextContent("Nacional · todas las provincias");
    pushSpy.mockRestore();
  });

  it("A11Y M2 (WCAG 4.1.3): a scope commit is announced in a polite live region", async () => {
    setUrl("/gob/panorama?period=3y");
    renderScopedConsole();

    // The live region exists and is silent on first paint (no announcement of
    // the initial scope — aria-live only fires on subsequent mutations).
    const live = screen.getByTestId("panorama-scope-live");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent("");

    const pushSpy = vi.spyOn(window.history, "pushState").mockImplementation(() => {});
    await act(async () => {
      (mapProps!.onProvinceDrill as (code: string) => void)("AR-B");
    });

    // After the commit the region publishes the new scope for a screen reader.
    expect(screen.getByTestId("panorama-scope-live")).toHaveTextContent("Alcance: Buenos Aires");
    pushSpy.mockRestore();
  });

  it("A11Y M1 (WCAG 2.4.3): committing a scope from the OPEN pill returns focus to the trigger", async () => {
    setUrl("/gob/panorama?period=3y");
    renderScopedConsole();

    // Open the jurisdiction disclosure and put focus on the trigger — the exact
    // keyboard path (Enter on the pill opens it, then the operator drives the
    // embedded <select>). The commit auto-closes the panel; M1 asserts focus is
    // RESTORED to the pill rather than dropped to <body> (a11y review round 2 —
    // the live-region text was covered, the focus landing was not).
    const pill = screen.getByTestId("panorama-scope-pill");
    const details = pill.closest("details") as HTMLDetailsElement;
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    pill.focus();
    expect(pill).toHaveFocus();

    const pushSpy = vi.spyOn(window.history, "pushState").mockImplementation(() => {});
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Provincia"), { target: { value: "AR-B" } });
    });

    expect(pill).toHaveFocus();
    expect(details.hasAttribute("open")).toBe(false);
    pushSpy.mockRestore();
  });

  it("QA fix (2026-07-11 §3): an OUT-OF-SCOPE province drill (not in allowedProvinces) shows the province NAME, not the raw ISO code", async () => {
    // A govt-local operator (allowedProvinces here is only AR-B/AR-C) can be
    // forced to an out-of-scope province via ?province= (e.g. a leak probe);
    // the fence still returns zero data, but the pill previously fell back to
    // the raw code ("AR-V") because it only looked the name up in
    // allowedProvinces — which never contains an out-of-scope code.
    setUrl("/gob/panorama?period=3y");
    renderScopedConsole();
    const pushSpy = vi.spyOn(window.history, "pushState").mockImplementation(() => {});

    await act(async () => {
      (mapProps!.onProvinceDrill as (code: string) => void)("AR-V");
    });

    const pill = screen.getByTestId("panorama-scope-pill");
    expect(pill).toHaveTextContent("Tierra del Fuego");
    expect(pill).not.toHaveTextContent("AR-V");
    pushSpy.mockRestore();
  });

  it("MEDIUM: a JurisdictionSwitcher province pick drives BOTH the map prop and the pill (switcher path)", async () => {
    setUrl("/gob/panorama?period=3y");
    renderScopedConsole();
    const pushSpy = vi.spyOn(window.history, "pushState").mockImplementation(() => {});

    // Pick a province in the embedded switcher `<select>` (commitScopeDrill).
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Provincia"), { target: { value: "AR-B" } });
    });

    // The client scope flows to the map (autozoom source) AND the pill together.
    expect(mapProps?.selectedProvinceCode).toBe("AR-B");
    expect(screen.getByTestId("panorama-scope-pill")).toHaveTextContent("Buenos Aires");
    pushSpy.mockRestore();
  });

  it("HIGH: browser Back after a drill resets the aggregation axis to province (national), not the stuck 'Localidades' view", async () => {
    setUrl("/gob/panorama?period=3y");
    renderScopedConsole();
    const pushSpy = vi.spyOn(window.history, "pushState").mockImplementation(() => {});

    // Drill into AR-B → the derived level flips to locality (scope-wins)…
    await act(async () => {
      (mapProps!.onProvinceDrill as (code: string) => void)("AR-B");
    });
    // …and the autozoom fits the province, leaving the camera at a drilled-in
    // zoom (past the province↔locality boundary).
    await act(async () => {
      (mapProps!.onZoom as (z: number) => void)(8);
    });
    // Sanity: the map now aggregates by the province's departments.
    expect(mapProps?.aggregationLabel).toBe("Departamentos/partidos");

    // Browser Back to national (pushState was mocked, so window.location is still
    // national — no ?province). Before the fix the level stayed "locality" off
    // the stale drilled-in zoom, so the national choropleth painted "Localidades"
    // ("sin datos en todo el país"). The revert must restore the province axis.
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(mapProps?.selectedProvinceCode).toBeNull();
    expect(mapProps?.aggregationLabel).toBe("Provincias");
    pushSpy.mockRestore();
  });

  it("HIGH: the in-map ← Volver also resets the axis to province (same reset as popstate)", async () => {
    setUrl("/gob/panorama?period=3y&province=AR-B");
    renderScopedConsole();
    const pushSpy = vi.spyOn(window.history, "pushState").mockImplementation(() => {});

    // Opened already drilled into AR-B (locality axis); camera at a drilled-in zoom.
    await act(async () => {
      (mapProps!.onZoom as (z: number) => void)(8);
    });
    expect(mapProps?.aggregationLabel).toBe("Departamentos/partidos");

    // ← Volver (onReturnNational → commitScopeDrill(null, null)).
    await act(async () => {
      (mapProps!.onReturnNational as () => void)();
    });

    expect(mapProps?.selectedProvinceCode).toBeNull();
    expect(mapProps?.aggregationLabel).toBe("Provincias");
    pushSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// panorama-percapita — the "por 10.000 hab." encoding (province grain, v1)
// ---------------------------------------------------------------------------

/** An ENRICHED province cell exactly as get-layer-features serves it for a
 * per-cápita-eligible layer (population/per10k/census metadata on the props). */
function enrichedProvinceFeature(
  province: string,
  count: number | null,
  per10k: number | null,
  suppressed = false,
) {
  return {
    type: "Feature" as const,
    geometry: { type: "Point" as const, coordinates: [-58.4, -34.6] },
    properties: {
      place: province,
      province,
      locality: null,
      departmentCode: null,
      level: "province",
      count,
      suppressed,
      population: suppressed ? null : 100_000,
      per10k,
      censusYear: 2022,
      censusSource: "INDEC Censo 2022",
    },
  };
}

const PERCAPITA_ENVELOPE = {
  features: {
    type: "FeatureCollection" as const,
    features: [
      enrichedProvinceFeature("Buenos Aires", 30, 3),
      enrichedProvinceFeature("Córdoba", 10, 1),
      // A k-anon suppressed cell: count hidden upstream → per10k null too.
      enrichedProvinceFeature("La Pampa", null, null, true),
    ],
  },
  truncated: false,
  suppressedCount: 0,
  noLocalityCount: 0,
  level: "province" as const,
};

/** fetch stub: denuncias serves the ENRICHED province envelope; kpis and every
 * other layer keep the shared defaults. */
function stubPercapitaFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("/api/panorama/kpis")
        ? INITIAL_KPIS
        : url.includes("/api/panorama/denuncias")
          ? PERCAPITA_ENVELOPE
          : OK_ENVELOPE;
      return Promise.resolve({ ok: true, json: async () => body } as unknown as Response);
    }),
  );
}

describe("PanoramaConsole — per-cápita encoding (panorama-percapita v1)", () => {
  it("offers the per-cápita mode on bienestar WITHOUT the '(en desarrollo)' roadmap option", async () => {
    setUrl("/gob/panorama?period=3y");
    stubPercapitaFetch();
    renderRedesignConsole();

    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Bienestar y fiscalización/ }));

    const toggle = await screen.findByRole("button", { name: "Per cápita (por 10.000 hab.)" });
    expect(toggle).toBeEnabled();

    // Visual review 2026-07-23 (#14): the disabled "Per cápita por departamento
    // (en desarrollo)" roadmap option is HIDDEN until the INDEC department
    // census import lands — a visibly unfinished control shipped to operators
    // reads as broken product, not roadmap.
    expect(
      screen.queryByRole("button", { name: "Per cápita por departamento (en desarrollo)" }),
    ).not.toBeInTheDocument();
  });

  it("selecting per-cápita re-encodes map + caption + footer together, and the URL reproduces it", async () => {
    setUrl("/gob/panorama?period=3y");
    stubPercapitaFetch();
    renderRedesignConsole();

    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /Bienestar y fiscalización/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Per cápita (por 10.000 hab.)" }));

    // MAP: the base layer is projected — label gains the unit, counts become
    // per-10k rates, the suppressed cell STAYS suppressed (no rate from a
    // hidden count), and the fractional-scale flag rides the layer.
    await waitFor(() => {
      const layers = (mapProps?.layers ?? []) as Array<{
        id: string;
        label: string;
        perCapita?: boolean;
        features: {
          features: Array<{ properties: { count: number | null; suppressed: boolean } }>;
        };
      }>;
      const denuncias = layers.find((l) => l.id === "denuncias");
      expect(denuncias).toBeDefined();
      expect(denuncias?.perCapita).toBe(true);
      expect(denuncias?.label).toBe("Denuncias de bienestar (por 10.000 hab.)");
      const counts = denuncias?.features.features.map((f) => f.properties.count);
      expect(counts).toEqual([3, 1, null]);
      const suppressed = denuncias?.features.features.map((f) => f.properties.suppressed);
      expect(suppressed).toEqual([false, false, true]);
    });

    // CAPTION: the measure names the denominator (label = map = caption canon).
    expect(screen.getByText(/denuncias de bienestar por 10\.000 habitantes/)).toBeInTheDocument();
    // FOOTER: year + source from the census table's own metadata, not hardcoded.
    expect(
      screen.getByText("Tasas por 10.000 habitantes — Censo 2022 (INDEC)"),
    ).toBeInTheDocument();
    // URL: the selection is a shareable coordinate (Copiar vista contract).
    await waitFor(() => {
      expect(window.location.search).toContain("encoding=percapita");
    });
  });

  it("a ?encoding=percapita deep link reproduces the per-cápita view", async () => {
    setUrl(
      "/gob/panorama?period=3y&preset=bienestar&layers=denuncias,decomisos&encoding=percapita",
    );
    stubPercapitaFetch();
    renderRedesignConsole();

    await waitFor(() => {
      const layers = (mapProps?.layers ?? []) as Array<{
        id: string;
        label: string;
        perCapita?: boolean;
      }>;
      const denuncias = layers.find((l) => l.id === "denuncias");
      expect(denuncias?.perCapita).toBe(true);
      expect(denuncias?.label).toBe("Denuncias de bienestar (por 10.000 hab.)");
    });
  });

  it("stays on counts (mode suspended) when the payload carries no census data", async () => {
    // Default fetch stub: denuncias serves UN-enriched features (no census in
    // the environment) → the selection must NOT fabricate rates; the honest
    // no-census note appears and the map keeps counts.
    setUrl(
      "/gob/panorama?period=3y&preset=bienestar&layers=denuncias,decomisos&encoding=percapita",
    );
    renderRedesignConsole();

    await waitFor(() => {
      const layers = (mapProps?.layers ?? []) as Array<{ id: string; perCapita?: boolean }>;
      const denuncias = layers.find((l) => l.id === "denuncias");
      expect(denuncias).toBeDefined();
      expect(denuncias?.perCapita).toBeUndefined();
    });
    expect(
      screen.getByText("Sin datos del censo para esta vista — se muestra el conteo."),
    ).toBeInTheDocument();
  });

  it("explains the POINTS view (not 'sin datos del censo') when an eligible layer serves near-band event dots (F3)", async () => {
    // A per-cápita-eligible layer (denuncias) that resolves to its NEAR-band
    // event-points mark carries NO per-unit counts to normalize — the server
    // serves real dots un-enriched (get-layer-features skips the census join for
    // points-mode results). The fallback note must name the POINTS view, never
    // the misleading "no census data" / department-drill cause.
    setUrl(
      "/gob/panorama?period=3y&preset=bienestar&layers=denuncias,decomisos&encoding=percapita",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        const body = url.includes("/api/panorama/kpis")
          ? INITIAL_KPIS
          : url.includes("mode=points")
            ? {
                mode: "points",
                features: {
                  type: "FeatureCollection",
                  features: [
                    {
                      type: "Feature",
                      geometry: { type: "Point", coordinates: [-58.4, -34.6] },
                      properties: { place: "Evento", locality: "X", province: "CABA" },
                    },
                  ],
                },
                truncated: false,
                sinUbicacionCount: 0,
              }
            : OK_ENVELOPE;
        return Promise.resolve({ ok: true, json: async () => body } as unknown as Response);
      }),
    );

    render(
      <PanoramaConsole
        defaultLayerId="perdidas"
        defaultFeatures={EMPTY_FC}
        initialKpis={INITIAL_KPIS}
        initialLevel="locality"
        initialDivisionProvince="AR-C"
      />,
    );

    // Zoom into the NEAR band (≥ Z_POINTS) so denuncias resolves to real dots.
    await act(async () => {
      (mapProps!.onZoom as (z: number) => void)(11);
    });

    // The points-mode note wins over the no-census / drill copy…
    expect(
      await screen.findByText(
        "En la vista de puntos se muestran eventos individuales — la tasa per cápita aplica a la vista agregada por provincia.",
      ),
    ).toBeInTheDocument();
    // …and the misleading no-census note is NOT shown.
    expect(
      screen.queryByText("Sin datos del censo para esta vista — se muestra el conteo."),
    ).not.toBeInTheDocument();
  });
});

describe("PanoramaConsole — camera lockdown opt-in stays OUT of the console (gob/map-zoom-lockdown follow-up, 2026-07-21)", () => {
  it("never passes `interactive` to SituationalMap — the console keeps free pan/zoom (SituationalMap's own default)", () => {
    renderConsole();
    // `interactive` is undefined here, NOT `false` — the console must not be
    // the one flipping the lock. SituationalMap defaults `interactive` to
    // `true` when the prop is absent, so free camera navigation is preserved
    // exactly as before this change. Only PanoramaEmbed (poblacion) opts in.
    expect(mapProps?.interactive).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// RA-7 — "the panorama must not count itself differently in two corners"
// (demo-funcionarios truth pass, 2026-07-31).
// ---------------------------------------------------------------------------

function stubCoberturaEnvelope(envelope: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      const payload = url.includes("/api/panorama/kpis")
        ? INITIAL_KPIS
        : url.includes("/api/panorama/cobertura") && !url.includes("histogram=1")
          ? envelope
          : OK_ENVELOPE;
      return Promise.resolve({ ok: true, json: async () => payload } as unknown as Response);
    }),
  );
}

function provinceCells(cells: Array<{ code: string; name: string; value: number }>) {
  return {
    features: {
      type: "FeatureCollection" as const,
      features: cells.map((c) => ({
        type: "Feature" as const,
        geometry: null,
        properties: { provinceCode: c.code, province: c.name, value: c.value },
      })),
    },
    truncated: false,
    suppressedCount: 0,
  };
}

describe("PanoramaConsole — RA-7 F5: the measured-units count is a MEASUREMENT, not a display cap", () => {
  // The 24 ISO jurisdictions, every one AT or ABOVE the 80% antirrábica meta.
  // `rankWorstUnits` therefore returns nothing (no unit is below target) and
  // PanoramaDataTable falls to its all-clear empty state — whose whole job is to
  // say HOW MUCH was looked at before claiming nothing is wrong.
  const ALL_COMPLIANT = [
    "AR-A",
    "AR-B",
    "AR-C",
    "AR-D",
    "AR-E",
    "AR-F",
    "AR-G",
    "AR-H",
    "AR-J",
    "AR-K",
    "AR-L",
    "AR-M",
    "AR-N",
    "AR-P",
    "AR-Q",
    "AR-R",
    "AR-S",
    "AR-T",
    "AR-U",
    "AR-V",
    "AR-W",
    "AR-X",
    "AR-Y",
    "AR-Z",
  ].map((code, i) => ({ code, name: `Jurisdiccion ${code}`, value: 85 + (i % 10) }));

  it("reports all 24 measured jurisdictions, never the Worst-N display cap of 10", async () => {
    // THE DEFECT: `rankingAllInScope` was built with `limit: RANKING_LIMIT` (10)
    // and its LENGTH was published as `measuredUnits`, so a fully compliant
    // national frame read "Se midieron 10 jurisdicciones y ninguna quedó por
    // debajo de la meta." A funcionario from any of the other 14 provinces is
    // told, in a sentence about coverage, that we did not look at theirs. The
    // Worst-N cap is a rendering budget; it has no business describing what was
    // measured.
    stubCoberturaEnvelope(provinceCells(ALL_COMPLIANT));
    renderConsole();

    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /^Cumplimiento$/ }));
    fireEvent.click(screen.getByRole("tab", { name: /Estadísticas/ }));

    expect(await screen.findByText(/Se midieron 24 jurisdicciones/)).toBeVisible();
    expect(screen.queryByText(/Se midieron 10 jurisdicciones/)).not.toBeInTheDocument();
  });

  it("still frames a SMALL scope as small (uncapping did not move the Worst-N threshold)", async () => {
    // The uncapped list has two other readers: `rankingSmallScope`
    // (`length < RANKING_LIMIT`) and, through it, the rendered rows. Six units is
    // under the cap either way, so the small-scope heading must survive — this is
    // the test that fails if someone "fixes" F5 by RAISING the cap instead of
    // removing it from the measurement.
    stubCoberturaEnvelope(
      provinceCells(ALL_COMPLIANT.slice(0, 6).map((c) => ({ ...c, value: 40 }))),
    );
    renderConsole();

    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /^Cumplimiento$/ }));
    fireEvent.click(screen.getByRole("tab", { name: /Estadísticas/ }));

    // "6 jurisdicciones · …" — the small-scope heading, not "Peores 6".
    // (T5.2 dropped the possessive "Tus" and fixed singular agreement.)
    expect(await screen.findByText(/6 jurisdicciones ·/)).toBeVisible();
  });
});

describe("PanoramaConsole — RA-7 F4: a FAILED level change says so; it never reads as 'sin datos'", () => {
  /** Province-grain succeeds; the department-grain refetch the LOD flip issues
   *  comes back 503 — the shape `fetchChoroplethAt` turns into `null`. */
  function stubLocalityFailure(provinceBody: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        if (url.includes("/api/panorama/kpis")) {
          return Promise.resolve({
            ok: true,
            json: async () => INITIAL_KPIS,
          } as unknown as Response);
        }
        const isCobertura = url.includes("/api/panorama/cobertura") && !url.includes("histogram=1");
        // The LOD flip to departments drops `level=province` from the query.
        if (isCobertura && !url.includes("level=province")) {
          return Promise.resolve({
            ok: false,
            status: 503,
            json: async () => ({}),
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          json: async () => (isCobertura ? provinceBody : OK_ENVELOPE),
        } as unknown as Response);
      }),
    );
  }

  it("marks the layer degraded so the empty canvas reads 'no pudimos calcular', not 'sin datos'", async () => {
    // THE DEFECT: `onLevelChange` fed the null body straight into the envelope
    // (`?? 0`, `?? false`, `=== true`), publishing `degraded: false` over a canvas
    // with nothing on it — the failed fetch also wrote nothing into the level
    // cache. `emptyOverlayMessage` then fell past its `layerDegraded` branch to
    // "Sin datos para esta capa …", the exact string LayerPanelState.degraded's
    // own docblock forbids for a timeout.
    stubLocalityFailure({ features: EMPTY_FC, truncated: false, suppressedCount: 0 });
    renderConsole();

    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /^Cumplimiento$/ }));
    await waitFor(() => {
      expect(mapProps?.onZoom).toBeInstanceOf(Function);
    });

    // Zoom past Z_DIVISIONS — the automatic department-grain LOD flip, whose
    // refetch fails.
    await act(async () => {
      (mapProps!.onZoom as (z: number) => void)(7);
    });

    // The flag reaches the map — this is the wire `emptyOverlayMessage` reads in
    // its HIGHEST-priority branch, the one that replaces "Sin datos para esta
    // capa …" with "No pudimos calcular esta capa a tiempo."
    await waitFor(() => {
      expect(mapProps?.layerDegraded).toBe(true);
    });
    // …and the console says it in words, naming the layer.
    expect(
      screen.getByText(/No pudimos calcular a tiempo: Cobertura antirrábica/),
    ).toBeInTheDocument();
  });

  it("does NOT zero the privacy/truncation envelope on a failed level change", async () => {
    // The same `?? 0` / `?? false` chain republished suppressedCount 0 and
    // truncated false for a request that returned nothing at all — a fabricated
    // privacy claim ("nothing was protected here") derived from a failure. The
    // last-known envelope is retained instead, under the degraded flag.
    stubLocalityFailure({ features: EMPTY_FC, truncated: true, suppressedCount: 7 });
    renderConsole();

    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /^Cumplimiento$/ }));
    // The province-grain answer disclosed 7 protected cells.
    expect(await screen.findByText(/^7 celdas con menos de 5 casos/)).toBeInTheDocument();

    await act(async () => {
      (mapProps!.onZoom as (z: number) => void)(7);
    });

    await waitFor(() => {
      expect(mapProps?.layerDegraded).toBe(true);
    });
    // The failure did not overwrite the privacy disclosure with a fabricated
    // zero: with the defect, suppressedCount fell to 0 and this pill vanished
    // entirely — a view silently claiming nothing had been protected.
    expect(screen.getByText(/^7 celdas con menos de 5 casos/)).toBeInTheDocument();
  });

  // RA-7 F4 (catch arm): the zoom-LOD tests above cover the !res.ok arm of
  // onLevelChange; the SCOPE/PERIOD invalidation effect's catch arm was the
  // last un-migrated failure path — a network THROW on a province drill
  // cleared `loading` but left degraded UNSET while the caches had already
  // been wiped, so the empty canvas fell through to the forbidden "Sin datos".
  it("a network-thrown refetch on a province drill marks the layer degraded — never 'sin datos'", async () => {
    // Start ALREADY drilled at locality level: a province→province drill then
    // keeps the aggregation level (no LOD flip), so the SCOPE/PERIOD
    // invalidation effect owns the only cobertura refetch — the exact arm
    // under test. (A national→province drill also flips the level, whose own
    // — already migrated — failure path would mask this arm's regression.)
    setUrl("/gob/panorama?period=3y&level=locality&province=AR-B");
    let failCobertura = false;
    const localFetch = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes("/api/panorama/kpis")) {
        return Promise.resolve({ ok: true, json: async () => INITIAL_KPIS } as unknown as Response);
      }
      if (url.includes("/api/panorama/scope")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ localities: [], localityCentroids: {} }),
        } as unknown as Response);
      }
      if (
        failCobertura &&
        url.includes("/api/panorama/cobertura") &&
        !url.includes("histogram=1")
      ) {
        // A THROW (network down), not an HTTP failure — the catch arm.
        return Promise.reject(new TypeError("network down"));
      }
      return Promise.resolve({ ok: true, json: async () => OK_ENVELOPE } as unknown as Response);
    });
    vi.stubGlobal("fetch", localFetch);
    renderConsole();

    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /^Cumplimiento$/ }));
    // Let the preset's own (successful) fetch burst settle first, so the
    // degraded flag below can only come from the drill's failed refetch.
    await waitFor(() => {
      const calls = localFetch.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.includes("/api/panorama/cobertura") && !u.includes("histogram=1"));
      expect(calls.length).toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(mapProps?.layerDegraded).not.toBe(true);
    });
    expect(mapProps?.onProvinceDrill).toBeInstanceOf(Function);

    // Now the network dies, and the operator drills into ANOTHER province —
    // the scope invalidation effect wipes the caches and refetches, which throws.
    failCobertura = true;
    await act(async () => {
      (mapProps!.onProvinceDrill as (code: string) => void)("AR-V");
    });

    await waitFor(() => {
      expect(mapProps?.layerDegraded).toBe(true);
    });
    // …and the console says it in words, naming the layer.
    expect(
      screen.getByText(/No pudimos calcular a tiempo: Cobertura antirrábica/),
    ).toBeInTheDocument();
  });
});

describe("PanoramaConsole — RA-7 F6: every protected-cell figure names the universe it measures", () => {
  it("the ranking line attributes its count to the RANKED LAYER, not to the view", () => {
    // Four numbers used to answer "cuántas celdas están protegidas", all able to
    // be on screen at once. This is the smallest of them — ONE layer's count —
    // and unnamed it read as a contradiction of the legend pill's view-wide
    // total rather than as the narrower, compatible claim it is.
    stubCoberturaEnvelope({
      features: EMPTY_FC,
      truncated: false,
      suppressedCount: 7,
    });
    renderConsole();

    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /^Cumplimiento$/ }));
    fireEvent.click(screen.getByRole("tab", { name: /Estadísticas/ }));

    return waitFor(() => {
      expect(
        screen.getByText(
          /unidades suprimidas por k-anonimato en Cobertura antirrábica \(perros, 12m\)/,
        ),
      ).toBeInTheDocument();
    });
  });

  it("the legend pill's figure declares itself as the VIEW-WIDE one", () => {
    // The counterpart claim: the widest figure says so, which is what makes the
    // smaller ones legible as subsets instead of disagreements.
    stubCoberturaEnvelope({ features: EMPTY_FC, truncated: false, suppressedCount: 7 });
    renderConsole();

    openVista();
    fireEvent.click(screen.getByRole("radio", { name: /^Cumplimiento$/ }));

    return waitFor(() => {
      expect(
        screen.getByText(/7 celdas con menos de 5 casos .* en las capas activas de esta vista/),
      ).toBeInTheDocument();
    });
  });
});

describe("PanoramaConsole — the ContextBar is the ONE place the answer lives", () => {
  // The pages hand the console a `scopeLabel` + `allowedProvinces`; both are
  // needed for the scope segment to mount.
  function renderBarConsole(extraProps: Record<string, unknown> = {}) {
    return render(
      <PanoramaConsole
        defaultLayerId="perdidas"
        defaultFeatures={EMPTY_FC}
        initialKpis={INITIAL_KPIS}
        scopeLabel="Nacional · todas las provincias"
        allowedProvinces={[{ code: "AR-B", name: "Buenos Aires" }]}
        {...extraProps}
      />,
    );
  }

  it("states scope, período and capas on one row ABOVE the map, before anything else", () => {
    // The decision maker's first question was answered in four-to-six places at
    // once. This is the one they should reach first — literally, in DOM order.
    setUrl("/gob/panorama?period=3y");
    renderBarConsole();

    const bar = screen.getByTestId("panorama-context-bar");
    expect(within(bar).getByTestId("panorama-scope-pill")).toHaveTextContent("Nacional");
    expect(within(bar).getByTestId("panorama-context-periodo")).toHaveTextContent(
      /últimos 3 años/i,
    );
    expect(within(bar).getByTestId("panorama-context-filtro")).toHaveTextContent(/capas?$|capas/);
    expect(isBefore(bar, screen.getByTestId("map-region"))).toBe(true);
  });

  it("the scope pill lives in the bar and NOWHERE else — moving it must not leave a copy", () => {
    // Adding a fifth surface would have been the opposite of the fix.
    setUrl("/gob/panorama?period=3y");
    renderBarConsole();

    const pills = screen.getAllByTestId("panorama-scope-pill");
    expect(pills).toHaveLength(1);
    expect(screen.getByTestId("panorama-context-bar")).toContainElement(pills[0]);
  });

  it("the scope panel still starts CLOSED (PO 2026-07-29) — the pill is the whole affordance", () => {
    setUrl("/gob/panorama?period=3y");
    renderBarConsole();

    const pill = screen.getByTestId("panorama-scope-pill");
    expect(pill.closest("details")?.hasAttribute("open")).toBe(false);
    expect(pill).toHaveAttribute("aria-expanded", "false");
  });

  it("Período opened from the BAR is the same single instance the rail opens", () => {
    // The whole point of sharing `panelOpen`: one state, one body, one mounted
    // panel — whichever trigger the operator reached for.
    setUrl("/gob/panorama?period=3y");
    renderBarConsole();

    fireEvent.click(screen.getByTestId("panorama-context-periodo"));
    expect(screen.getAllByRole("button", { name: "90 días" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Período" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    // Reaching for the rail icon MOVES the one panel; it never mounts a second.
    fireEvent.click(screen.getByRole("button", { name: "Período" }));
    expect(screen.getAllByRole("button", { name: "90 días" })).toHaveLength(1);
    expect(screen.getByTestId("panorama-context-periodo")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("one panel at a time across the three surfaces (bar segment, rail panel, scope disclosure)", () => {
    setUrl("/gob/panorama?period=3y");
    renderBarConsole();

    // Scope open → the bar's Período is closed and unmounted. jsdom does not
    // implement <summary> activation, so drive the native toggle the way the
    // A11Y M1 test above does — that IS the browser's path into our handler.
    const pill = screen.getByTestId("panorama-scope-pill");
    const details = pill.closest("details") as HTMLDetailsElement;
    act(() => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    expect(pill).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryAllByRole("button", { name: "90 días" })).toHaveLength(0);

    // Opening Período closes the scope disclosure — including on the keyboard
    // path, where no outside-pointer event ever fires.
    fireEvent.click(screen.getByTestId("panorama-context-periodo"));
    expect(screen.getByTestId("panorama-scope-pill")).toHaveAttribute("aria-expanded", "false");
    expect(screen.getAllByRole("button", { name: "90 días" })).toHaveLength(1);

    // ...and a rail panel closes the bar segment.
    fireEvent.click(screen.getByRole("button", { name: "Vista" }));
    expect(screen.queryAllByRole("button", { name: "90 días" })).toHaveLength(0);
    expect(screen.getByTestId("panorama-context-periodo")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("the redundant meta line above the KPI chips is GONE — the period is not restated there", () => {
    // It was the last survivor of stating the view four times: the period and
    // the layer set, re-wrapped beside truncated KPI numbers. The bar says it
    // once now; the KPI card must not say it again.
    setUrl("/gob/panorama?period=3y");
    renderBarConsole();

    const cluster = screen.getByTestId("panorama-scope-live").parentElement as HTMLElement;
    expect(within(cluster).queryByText(/últimos 3 años/i)).toBeNull();
    // ...and it did not simply VANISH: the bar states it, once.
    expect(screen.getByTestId("panorama-context-periodo")).toHaveTextContent(/últimos 3 años/i);
  });

  it("the Exportar panel mounts NO second saved-views popover — the bar owns the only one", () => {
    setUrl("/gob/panorama?period=3y");
    renderBarConsole();

    fireEvent.click(screen.getByRole("button", { name: "Exportar" }));
    expect(screen.getAllByRole("button", { name: "Vistas guardadas" })).toHaveLength(1);
    // The rail stays a complete index: it says where the control went.
    expect(screen.getByText(/vistas guardadas .* están en la barra de contexto/i)).toBeVisible();
  });
});
