"use client";

// use-panorama-kpis — the KPI strip's state + fetch effects, extracted
// MECHANICALLY from PanoramaConsole.tsx (file-size split, behavior-preserving):
// the three writers of the strip state (scope/period refetch, as-of refetch,
// streamed-seed resolution) plus the state/refs they share. The console keeps
// imperative write access (commitPeriod / popstate resync / selective refresh
// still call setKpis/setKpisStale directly), so the setters and the shared
// bookkeeping refs are returned alongside the values.

import { useEffect, useMemo, useRef, useState } from "react";

import { isAbortError, loadingPanoramaKpis } from "@/components/panorama/panorama-console-helpers";
import type { PanoramaKpis } from "@/src/modules/panorama/application/get-panorama-kpis";

type UsePanoramaKpisInput = {
  /** Server-rendered KPIs (awaited path) — seeds the strip when present. */
  initialKpis?: PanoramaKpis;
  /** perf plan 1.3 — the un-awaited streamed KPI promise (streaming path). */
  kpisPromise?: Promise<PanoramaKpis>;
  /** The scope+period qs subset (scopePeriodQsOf) the KPI refetch keys on. */
  scopePeriodQs: string;
  /** Stable ISO string of the active as-of cutoff; null = parked at live. */
  asOfIso: string | null;
  /** The ?asOf decoded ONCE from the mount URL (deep link), or null. */
  initialAsOf: Date | null;
  /** Keyed-abort signal factory — "kpis" is the shared strip abort key. */
  signalFor: (key: string) => AbortSignal;
};

export function usePanoramaKpis({
  initialKpis,
  kpisPromise,
  scopePeriodQs,
  asOfIso,
  initialAsOf,
  signalFor,
}: UsePanoramaKpisInput) {
  // Headline KPIs: seeded server-side, re-fetched when the scope/period
  // searchParams change so the strip stays IDENTICAL to the dashboards for the
  // active alcance. The API mirrors the [layer] route's auth + scope rules.
  const [kpis, setKpis] = useState<PanoramaKpis>(() => initialKpis ?? loadingPanoramaKpis());
  // perf plan 1.3: while the streamed KPI promise is unresolved the strip shows
  // a "Cargando indicadores…" pending state. True only on the streaming path (a
  // promise but no resolved seed); the awaited `initialKpis` path starts settled.
  const [kpisPending, setKpisPending] = useState<boolean>(
    initialKpis == null && kpisPromise != null,
  );
  // last-set-wins guard (perf plan 1.3): once a client refetch (a changed
  // scope/period) has taken over the KPI strip, the late-resolving streamed seed
  // — computed for the ORIGINAL scope — must not clobber the fresher client
  // numbers. Set when the refetch effect below actually issues a request.
  const clientKpiTookOverRef = useRef(false);
  // error-path audit 2026-07-04 finding E5: a failed KPI refetch used to be
  // silently swallowed, leaving stale numbers on screen with no signal that
  // they no longer reflect the active scope/period. kpisStale surfaces that
  // without touching the no-flash behavior (the last-known kpis stay put).
  const [kpisStale, setKpisStale] = useState(false);
  // Q13 — flash of stale national KPIs on a scope drill. `kpisPending` means the
  // scrubber's HOLD-while-revalidate (same scope, same numbers hold), so it must
  // NOT be reused here: a SCOPE change makes the current numbers belong to the
  // WRONG jurisdiction, and holding them is a "flash of lies". This distinct flag
  // is TRUE only while a scope/period change's KPI refetch is in flight; KpiChips
  // BLANKS (aria-busy placeholder) on it instead of holding the previous scope's
  // values. Cleared on settle (success or failure), where the strip resolves to
  // the fresh numbers (success) or the last-known + stale banner (failure).
  const [kpisScopeChanging, setKpisScopeChanging] = useState(false);

  // Build the KPI query string for the CURRENT scope/period + an optional as-of
  // cutoff. Shared by the as-of KPI effect below (the scope/period effect uses the
  // plain scopePeriodQs — no as-of, unchanged from before the hybrid).
  const kpiFetchQs = useMemo(() => {
    const params = new URLSearchParams(scopePeriodQs);
    if (asOfIso) params.set("asOf", asOfIso);
    return params.toString();
  }, [scopePeriodQs, asOfIso]);

  // Skip the refetch for the very first render (the server already seeded the
  // KPIs for the initial searchParams); only refetch when the filters change.
  const seededQsRef = useRef<string | null>(scopePeriodQs);
  useEffect(() => {
    if (seededQsRef.current === scopePeriodQs) {
      seededQsRef.current = null;
      return;
    }
    // perf plan 1.3: the scope/period changed → this client refetch owns the KPI
    // strip from here on. Mark the takeover so a late-resolving streamed seed
    // (computed for the previous scope) can no longer clobber these fresher
    // numbers when it settles.
    clientKpiTookOverRef.current = true;
    // Q13: the scope/period changed → the current numbers now belong to the
    // PREVIOUS scope. Blank the strip (aria-busy) for the in-flight refetch so a
    // CABA drill never flashes the old national values before the fresh figures
    // land. Cleared on settle below.
    setKpisScopeChanging(true);
    let cancelled = false;
    fetch(`/api/panorama/kpis${scopePeriodQs ? `?${scopePeriodQs}` : ""}`, {
      headers: { accept: "application/json" },
      signal: signalFor("kpis"),
    })
      .then((r) => (r.ok ? (r.json() as Promise<PanoramaKpis>) : null))
      .then((body) => {
        if (cancelled) return;
        if (body) {
          setKpis(body);
          setKpisStale(false);
        } else {
          setKpisStale(true);
        }
        // The client refetch settled → drop the initial streaming pending state
        // (a no-op once the seed already resolved) and the scope-transition blank.
        setKpisPending(false);
        setKpisScopeChanging(false);
      })
      .catch((err) => {
        // Superseded fetch (keyed abort) — a newer KPI request is in flight:
        // not a failure, the fresher response will land instead (and it owns the
        // scope-changing flag now, so leave it set).
        if (isAbortError(err)) return;
        // Leave the last-known KPIs in place on a transient failure (no
        // flash) but surface it — this used to be a silent no-op.
        if (cancelled) return;
        console.error("[PanoramaConsole] KPI refresh failed", err);
        setKpisStale(true);
        setKpisPending(false);
        setKpisScopeChanging(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scopePeriodQs, signalFor]);

  // Q13 safety net: the scope/period effect blanks the strip and clears the flag
  // on its OWN settle — but the as-of KPI effect below shares the "kpis" abort
  // key and can supersede the scope fetch (drill, then scrub). That aborts the
  // scope fetch, whose catch leaves the flag set assuming the winner manages it,
  // yet the as-of effect only tracks kpisPending. So clear the blank whenever
  // FRESH kpis actually land, from whichever effect — the numbers are current,
  // the strip must never stay stuck on "Actualizando…".
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the kpis value only — the "fresh data arrived" signal, not read in the body.
  useEffect(() => {
    setKpisScopeChanging(false);
  }, [kpis]);

  // Coherence hybrid (cowork QA H1) — a DEDICATED as-of KPI refetch, kept SEPARATE
  // from the scope/period effect above so the scrubber's rapid asOf changes never
  // re-run the scope-takeover bookkeeping (seededQsRef/clientKpiTookOverRef). When
  // the operator scrubs, the temporal KPIs (mordeduras/zoonosis/denuncias-in-period)
  // must recompute as-of the cutoff so the big numbers track the map + Registros the
  // scrubber already moves. Fires on every asOf transition — including back to live
  // (asOf→null, which the scope/period effect does NOT observe since scopePeriodQs is
  // unchanged) — so returning to "ahora" restores the live strip. `signalFor("kpis")`
  // shares the KPI abort key, so a rapid scrub supersedes in-flight requests.
  // A deep-linked ?asOf starts UNSEEDED so the mount effect's setAsOf triggers the
  // as-of KPI refetch to reconcile with the restored frame (the SSR seed already
  // used asOfSeed, so this refetch lands the same numbers — no flash).
  const asOfKpiSeededRef = useRef<boolean>(initialAsOf === null);
  const kpiFetchQsRef = useRef(kpiFetchQs);
  kpiFetchQsRef.current = kpiFetchQs;
  // biome-ignore lint/correctness/useExhaustiveDependencies: asOfIso is the sole intended trigger — scope/period changes are handled by the effect above; kpiFetchQs is read live via a ref and signalFor is stable.
  useEffect(() => {
    // Mount pass: skip when seeded at LIVE (server strip already matches). A deep
    // link that mounts WITH an ?asOf starts unseeded so the strip reconciles to the
    // restored scrub frame on mount.
    if (asOfKpiSeededRef.current) {
      asOfKpiSeededRef.current = false;
      return;
    }
    // Round-2 review #3: the map moves on THIS tick but the strip won't update
    // until the debounce + fetch land — showing the previous frame's numbers over
    // an as-of map is a transient invariant violation. Flip to the pending state
    // the MOMENT asOf changes so the strip reads "actualizando", never a stale
    // temporal number, until the fresh figure arrives.
    setKpisPending(true);
    // DEBOUNCE the as-of refetch: a scrub-DRAG emits a burst of asOf values, and a
    // KPI fetch per tick both hammers the endpoint and contends with the per-tick
    // temporal-LAYER refetch (which owns the map). Coalesce to the settled cutoff
    // (~250ms) so the strip catches up once the operator lands on a date — the map
    // still moves live via its own effect. (This also keeps the KPI fetch from
    // racing a layer toggle mid-scrub — cowork QA H1 regression.)
    let cancelled = false;
    const timer = setTimeout(() => {
      const qs = kpiFetchQsRef.current;
      clientKpiTookOverRef.current = true;
      fetch(`/api/panorama/kpis${qs ? `?${qs}` : ""}`, {
        headers: { accept: "application/json" },
        signal: signalFor("kpis"),
      })
        .then((r) => (r.ok ? (r.json() as Promise<PanoramaKpis>) : null))
        .then((body) => {
          if (cancelled) return;
          if (body) {
            setKpis(body);
            setKpisStale(false);
          } else {
            setKpisStale(true);
          }
          setKpisPending(false);
        })
        .catch((err) => {
          if (isAbortError(err) || cancelled) return;
          console.error("[PanoramaConsole] as-of KPI refresh failed", err);
          setKpisStale(true);
          // Never leave the strip stuck on the pending state after a real failure.
          setKpisPending(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // asOfIso is the sole trigger (scope/period changes are handled by the effect
    // above); kpiFetchQs/signalFor are read live via refs/stable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asOfIso]);

  // perf plan 1.3 — resolve the streamed KPI promise into state. The page creates
  // the loader promise and passes it un-awaited over RSC so SSR never blocks on
  // the (cold) KPI fan-out; here we await it on the client and drop the pending
  // state. The last-set-wins guard skips the assignment when a client refetch has
  // already superseded the seed (its scope/period differs), so a slow seed can't
  // overwrite fresher numbers. The page attaches `.catch(() =>
  // degradedPanoramaKpis())`, so this promise RESOLVES (never rejects) to either
  // the real strip or an honest degraded one; the `.catch` here is defensive.
  useEffect(() => {
    if (kpisPromise == null) return;
    let cancelled = false;
    // Promise.resolve() is load-bearing: an RSC-streamed promise arrives on the
    // client as a React thenable whose .then() returns undefined (not chainable),
    // so calling .catch() on the .then() result throws and the ErrorBoundary
    // takes down the whole console. Wrapping normalizes it to a real Promise.
    Promise.resolve(kpisPromise)
      .then((resolved) => {
        if (cancelled) return;
        // Gate the pending-clear the SAME way as setKpis: if a client fetch has
        // already taken over the strip (scope drill / period commit / scrub /
        // popstate) but hasn't settled yet, clearing pending here would expose the
        // gap where `kpis` is still the empty cold-start value — and the shared
        // `kpisDegraded = (…|| kpis.length===0) && !kpisPending` formula would flash
        // the honest-degraded copy ("No pudimos…") on BOTH the strip and the
        // informe before the owning fetch lands. That flash is a lie: nothing
        // failed, the seed just hadn't arrived. The owning fetch clears pending on
        // its own settle (every takeover site does), so leaving it pending here is
        // safe. Only the un-superseded seed clears pending. (Bug: /admin/panorama
        // first-paint flash — the national fan-out's wider pending window exposed it.)
        if (!clientKpiTookOverRef.current) {
          setKpis(resolved);
          setKpisPending(false);
        }
      })
      .catch(() => {
        if (cancelled) return;
        // Same gate: an owning client fetch clears pending itself; only clear here
        // when the seed is still the strip's source, so a rejected-but-superseded
        // seed can't flip pending off under a slower live fetch. Never leaves the
        // strip stuck pending in the un-superseded case.
        if (!clientKpiTookOverRef.current) setKpisPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [kpisPromise]);

  return {
    kpis,
    setKpis,
    kpisPending,
    kpisStale,
    setKpisStale,
    kpisScopeChanging,
    clientKpiTookOverRef,
    seededQsRef,
    kpiFetchQsRef,
  };
}
