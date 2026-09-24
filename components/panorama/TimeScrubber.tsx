"use client";

// TimeScrubber — Panorama's temporal-reproduction control (spec F4).
//
// THE flagship differentiator: scrub the active period [since, now] back in time
// to WATCH a situation form (e.g. the Salta rabies cluster forming over ~12 days).
// The control owns NO data — it just emits the current `asOf` Date (or null when
// parked at "ahora"/live) and the parent console refetches the active TEMPORAL
// layers with `?asOf=<iso>`. Non-temporal layers are dimmed by the console.
//
// ACCESSIBILITY (WCAG 2.1):
//   - the slider is a native <input type="range"> with an aria-label, an
//     aria-valuetext announcing the HUMAN as-of date (not the raw index), and
//     keyboard arrows that step whole days (native range behaviour over a 0..steps
//     domain). aria-valuemin/max/now are the native attributes.
//   - play/pause and reset are real <button>s with aria-pressed / aria-label.
//   - a live region announces the current as-of date as it changes.
//
// PLAY LOOP: play steps the slider forward one day every PLAY_INTERVAL_MS via a
// single setInterval, cleaned up on pause, on reaching "ahora", and on unmount.
// (Date.now() is fine in client components in this repo; only workflow scripts
// forbid it. The window's `until` is provided by the parent so the axis is stable.)
//
// panorama-vista-redesign Phase 4 (design Decision 4):
//   - `temporalAvailable`: false → the track is replaced by a dashed empty
//     state ("No disponible en esta vista"). Sourced EXCLUSIVELY from the
//     parent's `isTemporalLayer()` derivation over the active layer set — no
//     scrubber-local temporal set (the exact regression risk flagged in the
//     design). Activating a temporal layer flips this true and self-enables.
//   - loop chips (7/30/90 días): shade the trailing window and cycle the
//     thumb within it instead of stopping at "ahora". `looping` is CLIENT-ONLY
//     ephemeral state — never URL-encoded (same treatment as `basis`).
//   - `scrubDetail`: Simple (default) = play + track + loop chips + Ahora.
//     Detalle adds date-tick references along the track and the bitemporal
//     basis toggle (previously always-on, now behind Detalle).
//   - loop/tick math stays INSIDE this component, reusing the existing
//     exported domain primitives — domain/time-scrub.ts is NOT modified.

import Link from "next/link";
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { OverlayDisclosure } from "@/components/panorama/OverlayDisclosure";
import {
  RULE_CHANGE_ACTION_LABELS,
  type RuleChangeMarkerDatum,
  bucketRuleChangeMarkers,
  ruleChangeRuleLabel,
  ruleChangeScopeLabel,
} from "@/components/panorama/rule-change-markers";
import { formatTime } from "@/lib/utils/format";
import {
  type ScrubWindow,
  type TimeBasis,
  buildScrubWindow,
  dateToDayIndex,
  dayIndexToDate,
  formatAsOfDayLong,
  formatAsOfLabel,
  nextPlayIndex,
} from "@/src/modules/panorama/domain/time-scrub";

/** Ms between play-loop day steps at 1×. ~1.1s reads as a deliberate reconstruction. */
const PLAY_INTERVAL_MS = 1100;

/**
 * B2's 1×/2×/4× speed control was REVERTED before it ever shipped (perf review,
 * 2026-07-25). Two measured facts killed it:
 *
 *  - Each frame refetches every temporal layer, and app/api/panorama/_guard.ts
 *    caps an operator at 120 req/min. Measured at 4×: ~954 req/min, TEN
 *    successful layer responses across 35 requested frames — ~70% of playback
 *    silently lost to aborts and 429s. Even 1× crosses the cap at ~42 s.
 *  - The fade that justified 4× ("a continuous morph") does not exist: maplibre
 *    refuses to transition DATA-DRIVEN paint, and the choropleth's fill-color is
 *    an expression, so every frame snaps regardless.
 *
 * Faster playback needs the frame pipeline fixed first (coalesce the duplicate
 * fetch, gate the next frame on the previous landing instead of a wall clock,
 * share one debounce with the KPI strip). Until then a speed control just sells
 * the operator a faster way to lose frames.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Loop window lengths offered by the loop chips (days back from "ahora"). */
const LOOP_WINDOWS = [7, 30, 90] as const;
type LoopWindow = (typeof LOOP_WINDOWS)[number];

/**
 * PO copy fix (panorama v+1 review): the loop chips used to read "↺ 7/30/90
 * días" — the exact same vocabulary as PeriodPicker's "30 días"/"90 días"
 * chips ~200px away, but the two mean different things (this is the PLAYBACK
 * window the scrubber cycles through, not the DATA window the dashboard
 * queries). Naming the chips by calendar unit ("última semana/mes/trimestre")
 * keeps the two controls' vocabularies from colliding.
 */
const LOOP_WINDOW_LABELS: Record<LoopWindow, string> = {
  7: "última semana",
  30: "último mes",
  90: "último trimestre",
};

/** Number of date-tick references shown along the track in Detalle mode. */
const TICK_COUNT = 5;

type Props = {
  /** Active period lower bound (the dashboards' `since`). */
  since: Date;
  /** Active period upper bound ("ahora" / live). Usually now. */
  until: Date;
  /**
   * Emits the current as-of Date, or null when parked at the live edge. The
   * parent refetches active temporal layers with this (null → drop `asOf`).
   */
  onChange: (asOf: Date | null) => void;
  /**
   * task #77 bitemporal — the active replay basis. "valid" (occurred_at, default)
   * replays "what happened when"; "transaction" (recorded_at) replays "what the
   * State KNEW when". The parent owns this so it can thread it into the layer fetch.
   */
  basis: TimeBasis;
  /** Emits the chosen basis when the operator flips the toggle. */
  onBasisChange: (basis: TimeBasis) => void;
  /**
   * Fired when playback starts or stops. The dock listens so it can shrink to
   * the moving line while the map animates — the two-step shape the PO asked
   * for on 2026-08-01: configure tall, play minimal.
   *
   * Optional: a caller that does not care about the mode gets today's layout.
   */
  onPlayingChange?: (playing: boolean) => void;
  /**
   * WP4 — fired on the pointer-drag transitions of the track (true on the first
   * captured pointermove, false on release/cancel). A plain click never fires
   * it, so the parent can debounce the drag fan-out while click-to-seek stays
   * instant. Optional: a caller that does not care keeps today's behavior.
   */
  onDraggingChange?: (dragging: boolean) => void;
  /**
   * panorama-vista-redesign: whether the ACTIVE layer set has at least one
   * temporal layer (parent-derived via `isTemporalLayer()` — single source,
   * no scrubber-local set). false → the track is replaced by an empty state.
   * Defaults to true so existing callers (pre-redesign) keep today's behavior.
   */
  temporalAvailable?: boolean;
  /**
   * trust/safety (2026-07-10): es-AR measure of the PRIMARY/base layer when it
   * is CURRENT-STATE (e.g. "cobertura antirrábica"). The scrubber reproduces
   * only temporal layers; a current-state base is dimmed, never reconstructed —
   * so its dated "Situación al …" framing would fabricate a dated situation over
   * a metric that cannot vary with the fecha de corte. When set, the scrubber
   * renders an honest "estado actual — no varía con la fecha de corte" note.
   * Undefined when the base is temporal (no disclaimer needed).
   */
  currentStateBaseLabel?: string;
  /** Simple (default false) / Detalle (true) — persisted by the parent. */
  scrubDetail?: boolean;
  /**
   * Emits the chosen Simple/Detalle mode. Absent → the toggle is not
   * rendered (backward-compatible for callers that don't manage the pref).
   */
  onScrubDetailChange?: (value: boolean) => void;
  /**
   * panorama-vista-redesign QA fix: bumped by the parent whenever it forces
   * the board back to live OUTSIDE a `since`/`until` change — e.g. a
   * scope-only change (province/locality, period unchanged) or temporal
   * availability flipping off. `since`/`until` (and therefore `win`) can stay
   * IDENTICAL in both cases, so the existing win-change reset below never
   * fires; without this signal the scrubber keeps its stale internal index
   * and immediately re-emits a non-null `onChange`, undoing the parent's own
   * reset. Absent → no external-reset behavior (backward-compatible).
   */
  resetToken?: number;
  /**
   * "Copiar vista" fidelity: a shared scrub position to seek to ONCE on mount
   * (decoded from the URL by the parent). Applied in a mount-only effect (post-
   * hydration, so no SSR mismatch) — a value outside the active window is
   * ignored (the slider stays at the live edge). Absent → open at the live edge.
   */
  initialAsOf?: Date | null;
  /**
   * task #65 (kepler pattern): per-bin SCOPE-AGGREGATE signal counts over the
   * active [since, until] window (bin 0 = oldest), for the mini-histogram drawn
   * UNDER the track so operators jump to activity peaks. Built by the parent from
   * the already-fetched temporal-layer event timestamps; the bins are totals, never
   * per-unit, so they reveal no k-anon-suppressed cell. Absent/empty → no histogram
   * (e.g. the aggregated overview, whose features carry no per-event timestamp — a
   * scope-wide daily-count endpoint would light that case up; out of this scope).
   */
  histogramBins?: number[];
  /**
   * Watermark honesty (task #69): the last-event timestamp (data freshness). The
   * data is BATCH, not "en vivo", so the live edge reads "Al último evento: HH:MM"
   * (not "Ahora (en vivo)") and the DISPLAY axis quantizes its upper bound to this
   * watermark instead of Date.now() — a client-side presentation clamp only, so
   * the server's 300s cache-key bucketing is untouched. Absent/null → the label
   * degrades to a neutral "Al último evento" and the axis keeps `until`.
   */
  watermark?: Date | null;
  /**
   * política → resultado (2026-08-02): recent rule changes drawn as markers
   * along the track — Detalle mode only (Simple stays clean). Each marker is
   * TRANSACTION-BASIS BY CONSTRUCTION (`changedAt` = audit performed_at, when
   * the change was registered in DIM), positioned at that instant on the
   * shared axis. Fetched scope-filtered SERVER-SIDE by the parent (national
   * rules always included). Absent/empty → no marker layer.
   */
  ruleChangeMarkers?: RuleChangeMarkerDatum[];
  /**
   * The marker card's single link out — the surface carrying the full
   * "Correlación temporal — no implica causalidad" analysis (the Política →
   * resultado table). Only provided where the viewer can actually open it
   * (/admin/inteligencia is admin-only; a gob operator gets no dead link).
   */
  ruleChangeDetailHref?: string;
  /**
   * Cowork QA ronda 3 §5: TRUE when the PARENT still holds a non-null `asOf` (a
   * temporal frame is active). The "Ahora" reset is normally disabled at the live
   * edge (nothing to clear), but if the parent's `asOf` lingers while the slider
   * shows live — a stuck delta the operator could clear only by reloading — this
   * keeps "Ahora" an ALWAYS-available escape hatch back to the live delta/frame.
   * Absent → the button's enabled state derives from internal slider state only.
   */
  temporalActive?: boolean;
};

// A4 (motion review, perf track): memoized so a parent re-render that doesn't
// change any of this component's own props (e.g. an unrelated dock pane
// updating) skips its render pass — the play loop already ticks via its own
// setInterval and does not depend on the parent for that cadence.
function TimeScrubberImpl({
  since,
  until,
  onChange,
  basis,
  onBasisChange,
  onPlayingChange,
  onDraggingChange,
  temporalAvailable = true,
  currentStateBaseLabel,
  scrubDetail = false,
  onScrubDetailChange,
  resetToken,
  initialAsOf = null,
  watermark = null,
  histogramBins,
  ruleChangeMarkers,
  ruleChangeDetailHref,
  temporalActive = false,
}: Props) {
  // Rebuild the day-stepped axis only when the window endpoints change. Compare
  // by timestamp so a new Date object with the same instant does not rebuild.
  const sinceMs = since.getTime();
  // Watermark honesty: the DISPLAY axis ends at the last-event watermark, not at
  // `until` (≈ Date.now()). The data is batch, so the live edge is the last event
  // — clamp the axis to it when it falls within the window (never past `until`).
  const untilRawMs = until.getTime();
  const watermarkMs = watermark?.getTime() ?? null;
  const untilMs =
    watermarkMs !== null && watermarkMs > sinceMs && watermarkMs <= untilRawMs
      ? watermarkMs
      : untilRawMs;
  const win: ScrubWindow = useMemo(
    () => buildScrubWindow(new Date(sinceMs), new Date(untilMs)),
    [sinceMs, untilMs],
  );

  // Slider index 0..steps. `steps` (the max) is "ahora"/live.
  const [index, setIndex] = useState<number>(win.steps);
  const [playing, setPlaying] = useState(false);
  // Report the mode UP rather than lifting `playing` itself: the play loop, its
  // interval and every early-exit that pauses it all live in this component,
  // and moving that state out would scatter the loop's invariants across two
  // files for one layout decision.
  const notifyPlaying = onPlayingChange;
  useEffect(() => {
    notifyPlaying?.(playing);
  }, [playing, notifyPlaying]);
  // panorama-vista-redesign: the active loop window (null = not looping).
  const [looping, setLooping] = useState<LoopWindow | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // H4 (cowork QA): the native <input type=range> reads as "dead to the mouse" —
  // an operator dragging the thumb or clicking the bar saw nothing move (it stepped
  // only by keyboard). We drive seeking EXPLICITLY from pointer events on the track
  // wrapper (below) so drag + click-to-seek work deterministically; the native
  // input stays for keyboard + a11y (focused on pointerdown so arrow-keys follow a
  // click). `trackRef` measures the bar; `inputRef` receives focus.
  const trackRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // WP4 — whether a captured pointer-drag is in progress (transition-edged so
  // onDraggingChange fires once per drag, not once per pointermove).
  const draggingRef = useRef(false);
  // Review F4 (2026-08-15): if the scrubber unmounts MID-DRAG (dock collapse,
  // temporalAvailable flip) no pointerup ever fires, and the parent's dragging
  // flag would latch true — debouncing every later scrub for the session.
  // Same ref-current idiom as onChangeRef below.
  const onDraggingChangeRef = useRef(onDraggingChange);
  onDraggingChangeRef.current = onDraggingChange;
  useEffect(() => {
    return () => {
      if (draggingRef.current) {
        draggingRef.current = false;
        onDraggingChangeRef.current?.(false);
      }
    };
  }, []);

  const labelId = useId();
  const liveId = useId();

  // When the window changes (new period/scope), snap back to live and clear
  // any active loop (a new window invalidates the shaded range).
  useEffect(() => {
    setIndex(win.steps);
    setPlaying(false);
    setLooping(null);
  }, [win]);

  // panorama-vista-redesign QA fix: the parent's `resetToken` is an explicit
  // "park back to live" signal for transitions that do NOT change `win`
  // (scope-only changes, temporal availability flipping off — see the Props
  // doc comment). `win.steps` is read at fire time, not tracked reactively —
  // this must run ONLY when the token itself changes, mirroring the
  // win-change reset above.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetToken is the intentional sole trigger; win.steps is read live.
  useEffect(() => {
    if (resetToken === undefined) return;
    setIndex(win.steps);
    setPlaying(false);
    setLooping(null);
  }, [resetToken]);

  // "Copiar vista": seek ONCE on mount to a shared scrub day (if any). Declared
  // AFTER the win-change reset above so it wins the mount pass (that reset also
  // runs on mount, parking at live). A day outside the active window clamps to
  // the live edge via dateToDayIndex → treated as "no restore" (idx === steps).
  const initialAsOfSeekedRef = useRef(false);
  // While a URL-restored asOf is pending its mount seek, the scrubber sits at the
  // live edge and would emit a transient onChange(null) BEFORE the seek lands —
  // the parent's URL-sync then deletes ?asOf and re-adds it, a live flash that a
  // copy-during-flash captures as a live link. Suppress that pre-seek null (see
  // the onChange effect). Only armed when a restore is actually pending.
  const awaitingInitialSeekRef = useRef(initialAsOf !== null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only restore; win/initialAsOf read live.
  useEffect(() => {
    if (initialAsOfSeekedRef.current) return;
    initialAsOfSeekedRef.current = true;
    if (initialAsOf === null || win.steps === 0) {
      awaitingInitialSeekRef.current = false;
      return;
    }
    const idx = dateToDayIndex(win, initialAsOf);
    // A day inside the window restores; a clamped-out day is treated as "no
    // restore" — clear the guard so the normal live (null) emit is not swallowed.
    if (idx > 0 && idx < win.steps) setIndex(idx);
    else awaitingInitialSeekRef.current = false;
  }, []);

  // Derive the as-of Date for the current index. At the live edge → null.
  const atLive = index >= win.steps;
  const asOf = useMemo(() => (atLive ? null : dayIndexToDate(win, index)), [win, index, atLive]);
  // Watermark honesty (task #69): the live edge is the last INGESTED event, not a
  // real-time "now" — the data is batch. Label it as such and keep "en vivo" out.
  const watermarkTime =
    watermark !== null && !Number.isNaN(watermark.getTime())
      ? // AR-pinned (WARNING 6): FilterChips/KPI footer already render AR time,
        // so an unpinned local hour here would print two different times on one
        // screen. formatTime() carries the pin + hourCycle: "h23".
        formatTime(watermark)
      : null;
  const liveEdgeLabel =
    watermarkTime !== null ? `Al último evento: ${watermarkTime}` : "Al último evento";
  // T2.4: the HEADLINE as-of reads the one long UTC day shape every surface
  // shares ("8 de mayo de 2026" — context bar, export footer, pinned popup);
  // axis ticks below keep the compact formatAsOfLabel (space-bound furniture).
  const asOfLabel = atLive ? liveEdgeLabel : formatAsOfDayLong(dayIndexToDate(win, index));

  // Notify the parent whenever the resolved as-of changes (onChange via a ref so
  // a new callback identity each render does not re-fire the effect).
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    if (awaitingInitialSeekRef.current) {
      // Swallow the pre-seek live (null); wait for the restored day to land so
      // the parent never sees a transient live edge (avoids the ?asOf URL flash).
      if (asOf === null) return;
      awaitingInitialSeekRef.current = false;
    }
    onChangeRef.current(asOf);
  }, [asOf]);

  const stopInterval = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  // The shaded loop-window start index (7/30/90 days back from "ahora"),
  // clamped into [0, win.steps] via the existing dateToDayIndex primitive.
  const windowStartIndex = useMemo(() => {
    if (looping === null) return null;
    return dateToDayIndex(win, new Date(untilMs - looping * DAY_MS));
  }, [looping, win, untilMs]);

  // A degenerate window (single day) has nothing to scrub — render a hint
  // only. Computed here (ahead of the play effect below) so the play loop can
  // gate on it directly — see the panorama-vista-redesign QA fix note there.
  const scrubbable = win.steps > 0 && temporalAvailable;

  // Play loop: advance one step per tick. Outside a loop, stop cleanly at
  // "ahora" (unchanged behavior). Inside a loop, wrap back to the window
  // start instead of stopping — the reconstruction replays continuously
  // until "Ahora" is clicked.
  //
  // panorama-vista-redesign QA fix: gate on `scrubbable` too, not just
  // `playing` — without it, a play loop started before temporal gating hides
  // the controls (temporalAvailable flips false) kept ticking and calling
  // `onChange` behind the "No disponible en esta vista" empty state. Also
  // clear `playing` itself so a later re-enable doesn't silently resume.
  useEffect(() => {
    if (!playing) {
      stopInterval();
      return;
    }
    if (!scrubbable) {
      stopInterval();
      setPlaying(false);
      return;
    }
    intervalRef.current = setInterval(() => {
      setIndex((cur) => {
        const next = nextPlayIndex(win, cur);
        if (next === null) {
          if (windowStartIndex !== null) return windowStartIndex;
          // Reached the live edge — stop the loop on the next microtask.
          setPlaying(false);
          return win.steps;
        }
        return next;
      });
    }, PLAY_INTERVAL_MS);
    return stopInterval;
  }, [playing, scrubbable, win, stopInterval, windowStartIndex]);

  // Cleanup on unmount (belt-and-suspenders; the effect above also returns it).
  useEffect(() => stopInterval, [stopInterval]);

  const togglePlay = useCallback(() => {
    setPlaying((p) => {
      if (!p) {
        // Starting from the live edge restarts the reconstruction from `since`
        // (or the loop window start, if a loop is active).
        setIndex((cur) => (cur >= win.steps ? (windowStartIndex ?? 0) : cur));
        return true;
      }
      return false;
    });
  }, [win.steps, windowStartIndex]);

  const reset = useCallback(() => {
    setPlaying(false);
    setLooping(null);
    setIndex(win.steps);
    // Cowork QA ronda 3 §5: force the parent back to live UNCONDITIONALLY. When
    // the slider index is ALREADY at the live edge, moving it to `win.steps` is a
    // no-op, so the `asOf`-change effect never re-fires `onChange(null)` — and a
    // stale `asOf` (stuck delta) in the parent could only be cleared by a reload.
    // Emitting null here makes "Ahora" a guaranteed escape hatch. Clearing the
    // initial-seek guard ensures this null is never swallowed.
    awaitingInitialSeekRef.current = false;
    onChangeRef.current(null);
  }, [win.steps]);

  const onSlider = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setPlaying(false);
    setLooping(null);
    setIndex(Number(e.target.value));
  }, []);

  // H4 — map a clientX along the track to a day index (clamped to [0, steps]).
  const seekFromClientX = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (el === null || win.steps === 0) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) return;
      const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      setIndex(Math.round(frac * win.steps));
    },
    [win.steps],
  );

  // H4 — pointerdown seeks immediately (click-to-seek) and captures the pointer so
  // a drag keeps seeking even if it leaves the thin bar. Stops play/loop like the
  // native onChange would. Focuses the input so arrow-keys work after a click.
  const onTrackPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!scrubbable) return;
      e.preventDefault();
      setPlaying(false);
      setLooping(null);
      e.currentTarget.setPointerCapture(e.pointerId);
      inputRef.current?.focus();
      seekFromClientX(e.clientX);
    },
    [scrubbable, seekFromClientX],
  );

  // H4 — seek while dragging, but ONLY when the pointer is captured (pressed) so a
  // bare hover never moves the thumb.
  const onTrackPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!scrubbable || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
      if (!draggingRef.current) {
        draggingRef.current = true;
        onDraggingChange?.(true);
      }
      seekFromClientX(e.clientX);
    },
    [scrubbable, seekFromClientX, onDraggingChange],
  );

  const onTrackPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      if (draggingRef.current) {
        draggingRef.current = false;
        onDraggingChange?.(false);
      }
    },
    [onDraggingChange],
  );

  const startLoop = useCallback(
    (days: LoopWindow) => {
      const startIdx = dateToDayIndex(win, new Date(untilMs - days * DAY_MS));
      setLooping(days);
      setIndex(startIdx);
      setPlaying(true);
    },
    [win, untilMs],
  );

  const sinceLabel = formatAsOfLabel(dayIndexToDate(win, 0));

  // Q3 keyboard shortcuts — Espacio = play/pausa while focus is WITHIN the
  // scrubber region. Keydown on the section container, NO document-level
  // listener (a dock control must never hijack the page's keyboard). Guards:
  //   - buttons/summaries/links already activate on Space natively (the
  //     focused play button toggles by itself; a loop chip or "Ahora" must
  //     not ALSO flip playback) — skip them and let the browser work;
  //   - text-entry elements would type a space — skip them (defensive; the
  //     scrubber has none today);
  //   - the range input has NO native Space action, so the shortcut claims it
  //     (←/→ stay the input's NATIVE arrows: step=1 over the 0..steps domain
  //     is already one day/month per press — extended, not re-implemented).
  const onSectionKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.key !== " " && e.key !== "Spacebar") return;
      if (e.repeat || !scrubbable) return;
      const target = e.target as HTMLElement;
      if (target.closest("button, summary, a, select, textarea, [contenteditable='true']")) return;
      if (target instanceof HTMLInputElement && target.type !== "range") return;
      e.preventDefault();
      togglePlay();
    },
    [scrubbable, togglePlay],
  );

  // política → resultado: rule-change markers bucketed onto the track.
  // Detalle-only (v1 — Simple stays clean); out-of-window changes are dropped
  // by the bucketer, co-located ones merge into an "N cambios" chip (the
  // histogram's 48-bucket index math — see rule-change-markers.ts).
  const markerBuckets = useMemo(
    () =>
      scrubDetail && ruleChangeMarkers && ruleChangeMarkers.length > 0
        ? bucketRuleChangeMarkers(ruleChangeMarkers, win)
        : [],
    [scrubDetail, ruleChangeMarkers, win],
  );
  const showMarkers = scrubbable && markerBuckets.length > 0;

  // task #65: the mini-histogram's tallest bin, for normalizing bar heights. Only
  // rendered when there are bins AND a scrubbable window (a degenerate window has
  // no track to hang it under).
  const histogramPeak =
    histogramBins && histogramBins.length > 0 ? Math.max(...histogramBins, 0) : 0;
  const showHistogram = scrubbable && histogramPeak > 0;

  // Detalle-only: N evenly-spaced date-tick references along the track.
  const ticks = useMemo(() => {
    if (!scrubDetail || win.steps === 0) return [];
    return Array.from({ length: TICK_COUNT }, (_, i) => {
      const idx = Math.round((win.steps * i) / (TICK_COUNT - 1));
      return { idx, label: formatAsOfLabel(dayIndexToDate(win, idx)) };
    });
  }, [scrubDetail, win]);

  return (
    <section
      className="space-y-2 rounded-[var(--radius-lg)] border border-ln-op-line bg-ln-op-card/40 p-3"
      aria-labelledby={labelId}
      // Q3: Espacio = play/pausa while focus is within the scrubber region —
      // a region-scoped shortcut on the section's OWN keydown (never a
      // document listener). See onSectionKeyDown for the guards.
      onKeyDown={onSectionKeyDown}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p id={labelId} className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">
          Reproducción temporal
        </p>
        <div className="flex items-center gap-2">
          <p className="tabular-nums text-sm font-semibold text-ln-op-ink">{asOfLabel}</p>
          {onScrubDetailChange && (
            <fieldset className="m-0 inline-flex overflow-hidden rounded-[var(--radius-md)] border border-ln-op-line p-0">
              <legend className="sr-only">Modo de la reproducción temporal</legend>
              <button
                type="button"
                aria-pressed={!scrubDetail}
                aria-label="Modo simple de la reproducción temporal"
                onClick={() => onScrubDetailChange(false)}
                className={`px-2 py-0.5 text-sm font-medium transition-colors ${
                  !scrubDetail
                    ? "bg-ln-op-azul/10 text-ln-op-azul"
                    : "bg-ln-op-card text-ln-op-ink-2 hover:bg-ln-op-stripe"
                }`}
              >
                Simple
              </button>
              <button
                type="button"
                aria-pressed={scrubDetail}
                aria-label="Modo detalle de la reproducción temporal"
                onClick={() => onScrubDetailChange(true)}
                className={`px-2 py-0.5 text-sm font-medium transition-colors ${
                  scrubDetail
                    ? "bg-ln-op-azul/10 text-ln-op-azul"
                    : "bg-ln-op-card text-ln-op-ink-2 hover:bg-ln-op-stripe"
                }`}
              >
                Detalle
              </button>
            </fieldset>
          )}
        </div>
      </div>

      {/* PO ask (dock redesign audit): a PERSISTENT temporal-basis label — the
          Detalle-only "Base" toggle + its explanation sit further down (and
          require scrubDetail to render), so an operator scanning just the
          header could not tell whether the scrub is by fecha de ocurrencia
          or fecha de registro. This one-liner is unconditional (independent
          of scrubDetail/temporalAvailable) so the basis is always visible. */}
      <p className="text-xs text-ln-op-mute">
        Base: {basis === "transaction" ? "fecha de registro" : "fecha de ocurrencia"}
      </p>

      {!temporalAvailable ? (
        // H13 (cowork QA): reconcile with the KPI sparkline. The sparkline is a
        // 12-month TREND of the metric; this control REPRODUCES temporal event
        // layers as-of a date — a different tool. Say what it needs (an active
        // temporal layer) so "no disponible" doesn't contradict a visible trend.
        <p className="rounded-[var(--radius-md)] border border-dashed border-ln-op-line px-3 py-2 text-center text-sm text-ln-op-mute">
          La reproducción temporal necesita una capa de eventos activa (señales, denuncias). Activá
          una para ver la situación formarse. La tendencia del indicador se ve en su miniatura.
        </p>
      ) : (
        <>
          {/* trust/safety (2026-07-10): the base metric is current-state — the
              scrubber reproduces only temporal overlays, so state plainly that
              the dated corte does NOT move the headline layer (it is dimmed,
              not reconstructed). Without this the "Situación al …" label reads
              as if the whole map were as-of-t. */}
          {currentStateBaseLabel && (
            <p className="rounded-[var(--radius-md)] border border-dashed border-ln-op-line px-3 py-1.5 text-xs text-ln-op-mute">
              {/* H3 (cowork QA): in Señales de brote the base metric ({label}) is a
                  current-state stock, so the operator read the whole timeline as
                  "dead". Clarify that the scrubber DOES reproduce the temporal
                  overlays (señales); only the base metric stays fixed. */}
              La línea de tiempo reproduce las capas temporales del mapa (señales). El indicador
              base ({currentStateBaseLabel}) es un estado actual y no cambia con la fecha de corte.
            </p>
          )}
          {/* panorama QA root-cause #4: the histogram band below is absolutely
              positioned (bottom-full) with no flow space of its own, so it used
              to overlap the header/disclaimer above. `pt-6` reserves exactly its
              height (h-5 + mb-1 = 24px) in the flow, only when it will render. */}
          {/* política → resultado: `pb-7` mirrors the histogram's `pt-6` trick —
              the marker band below is absolutely positioned (top-full) with no
              flow space of its own, so reserve exactly its height (h-6 + mt-1 =
              28px) in the flow, only when it will render. */}
          <div
            className={`flex items-center gap-2.5 ${showHistogram ? "pt-6" : ""} ${
              showMarkers ? "pb-7" : ""
            }`}
          >
            <button
              type="button"
              onClick={togglePlay}
              disabled={!scrubbable}
              aria-pressed={playing}
              aria-keyshortcuts="Space"
              aria-label={
                playing ? "Pausar reproducción" : "Reproducir la formación de la situación"
              }
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card text-ln-op-ink hover:border-ln-op-azul disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon name={playing ? "pausa" : "reproducir"} size="sm" decorative />
            </button>

            <div
              ref={trackRef}
              onPointerDown={onTrackPointerDown}
              onPointerMove={onTrackPointerMove}
              onPointerUp={onTrackPointerUp}
              onPointerCancel={onTrackPointerUp}
              // H4: py-2/-my-2 grows the pointer HIT area to ~40px (a comfortable
              // drag/click target) without changing the surrounding layout — the
              // negative margin cancels the padding. touch-none stops a touch-drag
              // from scrolling the dock instead of seeking.
              className={`relative flex-1 py-2 -my-2 ${
                scrubbable ? "cursor-pointer touch-none" : "cursor-not-allowed"
              }`}
            >
              {/* task #65: signal histogram — SCOPE-AGGREGATE event volume over the
                  window, drawn just above the track so the operator can drag to a
                  peak. Decorative (the as-of label + live region carry the state);
                  bars are muted, the current scrub position is marked. */}
              {showHistogram && histogramBins && (
                <div
                  aria-hidden="true"
                  // A4: [container-type:inline-size] turns this div into the query
                  // container the marker's `cqw` unit below resolves against — a
                  // length, not a %, so translateX(Ncqw) moves the marker across
                  // THIS box's width instead of its own 1px width (the classic
                  // transform-percentage pitfall for a `w-px` element).
                  className="pointer-events-none absolute inset-x-0 bottom-full mb-1 flex h-5 items-end gap-px [container-type:inline-size]"
                >
                  {histogramBins.map((count, i) => (
                    <span
                      // biome-ignore lint/suspicious/noArrayIndexKey: bins are a fixed-length positional series (bin i is always the i-th time bucket) — never reordered, so the index IS the stable identity.
                      key={`sig-bin-${i}`}
                      className="flex-1 rounded-t-[1px] bg-ln-op-mute/40"
                      style={{ height: `${(count / histogramPeak) * 100}%` }}
                    />
                  ))}
                  {win.steps > 0 && (
                    <span
                      // A4 (motion review): was `left: X%` (layout) — every play
                      // step (PLAY_INTERVAL_MS = 1100ms) reflowed and popped the
                      // marker to its new spot. transform/translateX is
                      // compositor-only, and the transition below is plain CSS —
                      // the global prefers-reduced-motion block (globals.css)
                      // already collapses it, no useReducedMotion() needed here.
                      className="absolute inset-y-0 left-0 w-px bg-ln-op-azul/80 transition-transform duration-150 ease-linear"
                      style={{ transform: `translateX(${(index / win.steps) * 100}cqw)` }}
                    />
                  )}
                </div>
              )}
              {/* Shaded loop-window overlay — purely visual, sits under the range
                  input. Pinned to the BAR height (not the enlarged H4 hit box) so
                  the shade stays a thin pill behind the 6px track. */}
              {windowStartIndex !== null && win.steps > 0 && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-ln-op-azul/15"
                  style={{
                    left: `${(windowStartIndex / win.steps) * 100}%`,
                    right: 0,
                  }}
                />
              )}
              <input
                ref={inputRef}
                type="range"
                min={0}
                max={win.steps}
                step={1}
                value={index}
                onChange={onSlider}
                disabled={!scrubbable}
                // H4: pointer is owned by the track wrapper (deterministic drag +
                // click-to-seek); the input stays for keyboard + a11y and reflects
                // the value. A styled thumb (webkit + moz) makes the grab point
                // visible — an unstyled appearance-none range renders NO thumb in
                // WebKit, which is what made the control look dead.
                className="pointer-events-none relative block h-1.5 w-full appearance-none rounded-full bg-ln-op-line accent-ln-op-azul disabled:opacity-40 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-white [&::-moz-range-thumb]:bg-ln-op-azul [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:bg-ln-op-azul [&::-webkit-slider-thumb]:shadow"
                aria-label="Línea de tiempo: arrastrá para ver la situación en una fecha anterior"
                aria-valuemin={0}
                aria-valuemax={win.steps}
                aria-valuenow={index}
                aria-valuetext={asOfLabel}
              />
              {/* política → resultado: rule-change markers under the track.
                  Positioned with the SAME container-query transform the
                  histogram playhead uses (translateX in cqw — compositor-safe,
                  no per-render layout), at dateToDayIndex/win.steps — the exact
                  fraction the thumb occupies on that day. TRANSACTION BASIS BY
                  CONSTRUCTION: the card always reads "Cambio registrado el …",
                  never "vigente desde", regardless of the replay-basis toggle
                  (a marker is when the change entered DIM, not when the
                  real-world decision happened — that date is unknowable).
                  Stays visible during playback: it annotates the axis the
                  playhead crosses (like the histogram), it is not
                  configuration, so the two-step fold does not apply.
                  stopPropagation keeps a chip tap from ALSO seeking the track
                  (the wrapper's pointerdown owns click-to-seek). */}
              {showMarkers && (
                <div
                  className="absolute inset-x-0 top-full mt-1 h-6 [container-type:inline-size]"
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  {markerBuckets.map((b) => (
                    <div
                      key={b.key}
                      className="absolute left-0 top-0"
                      style={{ transform: `translateX(calc(${b.fraction * 100}cqw - 50%))` }}
                    >
                      <OverlayDisclosure
                        side="up"
                        summaryTestId={`rule-change-marker-${b.key}`}
                        summaryClassName="inline-flex h-5 min-w-4 items-center justify-center gap-1 whitespace-nowrap rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card px-1 text-sm font-semibold tabular-nums text-ln-op-ink-2 hover:border-ln-op-azul"
                        panelClassName={`w-72 space-y-2 text-left ${
                          b.fraction > 0.5 ? "right-0" : "left-0"
                        }`}
                        summary={
                          b.changes.length === 1 ? (
                            <>
                              <Icon name="marca-regla" size="sm" decorative />
                              <span className="sr-only">Cambio de regla</span>
                            </>
                          ) : (
                            `${b.changes.length} cambios`
                          )
                        }
                      >
                        <ul className="m-0 list-none space-y-2 p-0">
                          {b.changes.map((c) => (
                            <li key={c.auditId} className="space-y-0.5">
                              <p className="text-sm font-semibold text-ln-op-ink">
                                {ruleChangeRuleLabel(c.ruleType)}{" "}
                                <span className="font-normal text-ln-op-mute">
                                  (regla {RULE_CHANGE_ACTION_LABELS[c.action]})
                                </span>
                              </p>
                              <p className="text-xs text-ln-op-mute">{ruleChangeScopeLabel(c)}</p>
                              <p className="text-xs text-ln-op-mute">
                                Cambio registrado el {formatAsOfDayLong(new Date(c.changedAt))}
                              </p>
                            </li>
                          ))}
                        </ul>
                        {ruleChangeDetailHref && (
                          <Link
                            href={ruleChangeDetailHref}
                            className="inline-block text-xs font-medium text-ln-op-azul hover:underline"
                          >
                            Ver análisis en Inteligencia →
                          </Link>
                        )}
                      </OverlayDisclosure>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={reset}
              // Enabled whenever there is temporal state to clear: the slider is
              // off the live edge / playing / looping, OR the parent still holds a
              // non-null asOf (temporalActive) — the latter re-enables the escape
              // hatch even at the live edge so a stuck delta is never uncleanable.
              disabled={atLive && !playing && looping === null && !temporalActive}
              aria-label="Volver al último evento"
              className="inline-flex h-7 shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card px-2 text-sm text-ln-op-ink-2 hover:border-ln-op-azul disabled:cursor-not-allowed disabled:opacity-40"
            >
              Ahora
            </button>
          </div>

          <div className="flex items-center justify-between text-xs text-ln-op-mute">
            <span className="tabular-nums">{sinceLabel}</span>
            <span className="tabular-nums">Último evento</span>
          </div>

          {/* The caveat TRAVELS WITH the marker layer (research-locked design):
              the map must never become the most persuasive unhedged surface —
              the full "no implica causalidad" analysis lives with the Política
              → resultado table; this line is its terse traveling companion. */}
          {showMarkers && (
            <p className="text-xs text-ln-op-mute">
              Marcas: cambios de reglas. Correlación temporal, no atribución.
            </p>
          )}

          {/* Detalle: date-tick references along the track.
              CONFIGURATION, so hidden while playing (PO 2026-08-01 — see the
              two-step note in the module header). The ticks answer "which dates
              can I land on"; once the thumb is moving, the watermark above
              already says which date you ARE on. */}
          {scrubDetail && !playing && ticks.length > 0 && (
            <div
              className="flex items-center justify-between text-xs text-ln-op-faint"
              aria-hidden="true"
            >
              {ticks.map((t) => (
                <span key={t.idx} className="tabular-nums">
                  {t.label}
                </span>
              ))}
            </div>
          )}

          {/* Loop chips — shade a trailing window and cycle the thumb within it.
              QA fix: the 7/30/90-day windows are computed as CALENDAR-DAY
              offsets (startLoop/windowStartIndex above), but a long period
              (> 90 days, e.g. the "3y" Panorama default) steps the axis by
              whole MONTHS (buildScrubWindow) — the day math only approximates
              a month-stepped index, making the shaded window/thumb position
              dishonest. Disable the chips with a hint instead of shipping an
              approximate reconstruction.

              THESE STAY VISIBLE WHILE PLAYING, unlike the ticks and the basis
              selector. They read as configuration, and the first cut of the
              two-step layout folded them away — which the loop tests caught
              immediately, for a better reason than "a test broke": clicking a
              chip STARTS playback, and while the loop runs these chips are the
              only thing saying WHICH window is cycling (aria-pressed) and the
              only way to switch it. Folding them removes the control at the
              exact moment it is in use. They cost one short row. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              aria-hidden="true"
              className="mr-1 text-sm font-semibold uppercase tracking-[0.08em] text-ln-op-mute"
            >
              Ventana de reproducción
            </span>
            {LOOP_WINDOWS.map((days) => (
              <button
                key={days}
                type="button"
                aria-pressed={looping === days}
                disabled={!scrubbable || win.step === "month"}
                title={
                  win.step === "month"
                    ? "No disponible: el período activo reproduce por mes, no por día."
                    : undefined
                }
                onClick={() => startLoop(days)}
                className={`rounded-[var(--radius-md)] border px-2 py-1 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  looping === days
                    ? "border-ln-op-azul bg-ln-op-azul/10 font-semibold text-ln-op-ink"
                    : "border-ln-op-line bg-ln-op-card text-ln-op-ink-2 hover:border-ln-op-azul"
                }`}
              >
                ↺ {LOOP_WINDOW_LABELS[days]}
              </button>
            ))}
          </div>
          {/* The hint explains why the chips above are disabled, so it lives and
              dies with them. */}
          {scrubbable && win.step === "month" && (
            <p className="text-sm text-ln-op-mute">
              Los atajos de repetición no están disponibles para períodos largos (reproducción
              mensual).
            </p>
          )}

          {/* task #77 bitemporal — replay-basis toggle. Detalle-only (panorama-
              vista-redesign): default "valid" replays by occurred_at ("cuándo
              pasó"); "transaction" replays by recorded_at ("cuándo lo supo el
              Estado"). The gap between the two IS the reporting-lag signal. */}
          {scrubDetail && !playing && (
            <>
              <fieldset className="m-0 flex flex-wrap items-center gap-1.5 border-0 p-0">
                <legend className="sr-only">Base temporal de la reproducción</legend>
                <span
                  aria-hidden="true"
                  className="mr-1 text-sm font-semibold uppercase tracking-[0.08em] text-ln-op-mute"
                >
                  Base
                </span>
                <button
                  type="button"
                  aria-pressed={basis === "valid"}
                  onClick={() => onBasisChange("valid")}
                  className={`rounded-[var(--radius-md)] border px-2 py-1 text-sm transition-colors ${
                    basis === "valid"
                      ? "border-ln-op-azul bg-ln-op-azul/10 font-semibold text-ln-op-ink"
                      : "border-ln-op-line bg-ln-op-card text-ln-op-ink-2 hover:border-ln-op-azul"
                  }`}
                >
                  Cuándo ocurrió
                </button>
                <button
                  type="button"
                  aria-pressed={basis === "transaction"}
                  onClick={() => onBasisChange("transaction")}
                  className={`rounded-[var(--radius-md)] border px-2 py-1 text-sm transition-colors ${
                    basis === "transaction"
                      ? "border-ln-op-azul bg-ln-op-azul/10 font-semibold text-ln-op-ink"
                      : "border-ln-op-line bg-ln-op-card text-ln-op-ink-2 hover:border-ln-op-azul"
                  }`}
                >
                  Según lo conocido al momento
                </button>
              </fieldset>

              {/* T5.11: BOTH branches state the two temporal bases once — the
                  default (occurrence) branch used to explain nothing, so the
                  distinction only surfaced after switching to transaction. */}
              <p className="text-sm text-ln-op-mute">
                {basis === "transaction"
                  ? "Reproduciendo por fecha de registro (cuándo el Estado tomó conocimiento): la brecha con la fecha de ocurrencia revela demoras de reporte y presencia territorial."
                  : "Reproduciendo por fecha de ocurrencia (cuándo sucedió el hecho); la fecha de registro puede ser posterior. Las capas sin dimensión temporal se atenúan durante la reproducción."}
              </p>
            </>
          )}
        </>
      )}

      {/* Live region: announces the as-of date to assistive tech as it changes.
          At the live edge the label already reads "Al último evento: HH:MM", so
          skip the "Situación al" prefix there to avoid a doubled "al". */}
      <p id={liveId} className="sr-only" aria-live="polite">
        {atLive ? asOfLabel : `Situación al ${asOfLabel}`}
      </p>
    </section>
  );
}

export const TimeScrubber = memo(TimeScrubberImpl);
