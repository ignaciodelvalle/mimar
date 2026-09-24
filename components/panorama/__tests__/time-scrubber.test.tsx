// @vitest-environment jsdom
//
// TimeScrubber — panorama-vista-redesign Phase 4 (loops / ticks / temporal
// gating). Temporal availability is sourced EXCLUSIVELY from the parent's
// `isTemporalLayer()` derivation (design Decision 4) — these tests pin the
// `temporalAvailable` prop contract, not a scrubber-local temporal set.

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TimeScrubber } from "@/components/panorama/TimeScrubber";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const SINCE = new Date("2026-06-01T00:00:00Z");
const UNTIL = new Date("2026-07-01T00:00:00Z");

describe("TimeScrubber — watermark honesty (task #69)", () => {
  it("labels the live edge as the last event (no 'en vivo')", () => {
    render(
      <TimeScrubber
        since={SINCE}
        until={UNTIL}
        onChange={vi.fn()}
        basis="valid"
        onBasisChange={vi.fn()}
        watermark={new Date("2026-06-30T14:37:00Z")}
      />,
    );

    // The live edge reads "Al último evento: HH:MM" (rendered in both the visible
    // header and the sr-only live region — hence getAllByText); "en vivo" is gone,
    // and the axis upper bound is relabeled from "Ahora" to "Último evento".
    expect(screen.getAllByText(/Al último evento:/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/en vivo/i)).not.toBeInTheDocument();
    expect(screen.getByText("Último evento")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Volver al último evento" })).toBeInTheDocument();
  });

  it("degrades to a neutral 'Al último evento' when no watermark is provided", () => {
    render(
      <TimeScrubber
        since={SINCE}
        until={UNTIL}
        onChange={vi.fn()}
        basis="valid"
        onBasisChange={vi.fn()}
      />,
    );
    expect(screen.getAllByText("Al último evento").length).toBeGreaterThan(0);
    expect(screen.queryByText(/en vivo/i)).not.toBeInTheDocument();
  });
});

describe("TimeScrubber — temporal gating (design Decision 4)", () => {
  it("non-temporal vista: temporalAvailable=false shows the empty state instead of the track", () => {
    render(
      <TimeScrubber
        since={SINCE}
        until={UNTIL}
        onChange={vi.fn()}
        basis="valid"
        onBasisChange={vi.fn()}
        temporalAvailable={false}
      />,
    );

    expect(
      screen.getByText(/La reproducción temporal necesita una capa de eventos activa/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
  });

  it("adding a temporal layer self-enables the scrubber (temporalAvailable flips true, no reload)", () => {
    const { rerender } = render(
      <TimeScrubber
        since={SINCE}
        until={UNTIL}
        onChange={vi.fn()}
        basis="valid"
        onBasisChange={vi.fn()}
        temporalAvailable={false}
      />,
    );
    expect(
      screen.getByText(/La reproducción temporal necesita una capa de eventos activa/),
    ).toBeInTheDocument();

    rerender(
      <TimeScrubber
        since={SINCE}
        until={UNTIL}
        onChange={vi.fn()}
        basis="valid"
        onBasisChange={vi.fn()}
        temporalAvailable={true}
      />,
    );

    expect(
      screen.queryByText(/La reproducción temporal necesita una capa de eventos activa/),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("slider")).toBeInTheDocument();
  });

  it("current-state base: shows the honest 'estado actual' disclaimer alongside the active track (trust/safety)", () => {
    // A temporal overlay keeps the scrubber active, but the base metric is
    // current-state — the dated label must not imply it varies with the corte.
    render(
      <TimeScrubber
        since={SINCE}
        until={UNTIL}
        onChange={vi.fn()}
        basis="valid"
        onBasisChange={vi.fn()}
        temporalAvailable={true}
        currentStateBaseLabel="cobertura antirrábica"
      />,
    );

    expect(screen.getByRole("slider")).toBeInTheDocument();
    expect(
      screen.getByText(/El indicador base \(cobertura antirrábica\) es un estado actual/),
    ).toBeInTheDocument();
  });

  it("temporal base: no current-state disclaimer is rendered", () => {
    render(
      <TimeScrubber
        since={SINCE}
        until={UNTIL}
        onChange={vi.fn()}
        basis="valid"
        onBasisChange={vi.fn()}
        temporalAvailable={true}
      />,
    );

    expect(screen.queryByText(/no cambia con la fecha de corte/)).not.toBeInTheDocument();
  });

  it("defaults to available (temporalAvailable omitted) — backward compatible", () => {
    render(
      <TimeScrubber
        since={SINCE}
        until={UNTIL}
        onChange={vi.fn()}
        basis="valid"
        onBasisChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("slider")).toBeInTheDocument();
  });
});

describe("TimeScrubber — loop windows", () => {
  it("starting a 30-day loop shades the window and moves the thumb off the live edge", () => {
    render(
      <TimeScrubber
        since={SINCE}
        until={UNTIL}
        onChange={vi.fn()}
        basis="valid"
        onBasisChange={vi.fn()}
      />,
    );

    const slider = screen.getByRole("slider") as HTMLInputElement;
    expect(slider.value).toBe(slider.max); // starts live

    fireEvent.click(screen.getByRole("button", { name: "↺ último mes" }));

    expect(Number(slider.value)).toBeLessThan(Number(slider.max));
    expect(screen.getByRole("button", { name: "↺ último mes" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("'Ahora' clears the loop and returns to live", () => {
    render(
      <TimeScrubber
        since={SINCE}
        until={UNTIL}
        onChange={vi.fn()}
        basis="valid"
        onBasisChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "↺ última semana" }));
    expect(screen.getByRole("button", { name: "↺ última semana" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Volver al último evento" }));

    const slider = screen.getByRole("slider") as HTMLInputElement;
    expect(slider.value).toBe(slider.max);
    expect(screen.getByRole("button", { name: "↺ última semana" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("the loop keeps cycling within the window instead of stopping at 'ahora'", () => {
    vi.useFakeTimers();
    render(
      <TimeScrubber
        since={SINCE}
        until={UNTIL}
        onChange={vi.fn()}
        basis="valid"
        onBasisChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "↺ última semana" }));
    const slider = screen.getByRole("slider") as HTMLInputElement;
    const startIndex = Number(slider.value);

    // Advance past the full 7-day window (well beyond 7 ticks at 1.1s each).
    act(() => {
      vi.advanceTimersByTime(1100 * 20);
    });

    // Still playing (aria-pressed on play button), never reached/parked at live.
    expect(screen.getByRole("button", { name: "Pausar reproducción" })).toBeInTheDocument();
    // The index wrapped back near the window start rather than climbing forever.
    expect(Number(slider.value)).toBeLessThanOrEqual(startIndex + 8);
  });
});

describe("TimeScrubber — QA fix: playback stops when temporal gating hides the controls", () => {
  it("a running play loop stops advancing once temporalAvailable flips false (no onChange behind the empty state)", () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { rerender } = render(
      <TimeScrubber
        since={SINCE}
        until={UNTIL}
        onChange={onChange}
        basis="valid"
        onBasisChange={vi.fn()}
        temporalAvailable={true}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Reproducir la formación de la situación" }),
    );
    expect(screen.getByRole("button", { name: "Pausar reproducción" })).toBeInTheDocument();
    onChange.mockClear();

    // Temporal gating hides the controls — the empty state replaces the track.
    rerender(
      <TimeScrubber
        since={SINCE}
        until={UNTIL}
        onChange={onChange}
        basis="valid"
        onBasisChange={vi.fn()}
        temporalAvailable={false}
      />,
    );
    expect(
      screen.getByText(/La reproducción temporal necesita una capa de eventos activa/),
    ).toBeInTheDocument();

    // Advance well past several play-loop ticks — the interval must not still
    // be running behind the empty state.
    act(() => {
      vi.advanceTimersByTime(1100 * 5);
    });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("TimeScrubber — QA fix: resetToken forces a live reset independent of `win`", () => {
  it("parks back at live and clears play/loop when resetToken bumps, even though since/until are unchanged", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <TimeScrubber
        since={SINCE}
        until={UNTIL}
        onChange={onChange}
        basis="valid"
        onBasisChange={vi.fn()}
        resetToken={0}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "↺ última semana" }));
    const slider = screen.getByRole("slider") as HTMLInputElement;
    expect(Number(slider.value)).toBeLessThan(Number(slider.max));
    onChange.mockClear();

    // Same since/until (win is unchanged) — only the token bumps, mirroring a
    // scope-only change or a temporalAvailable flip the parent handled itself.
    rerender(
      <TimeScrubber
        since={SINCE}
        until={UNTIL}
        onChange={onChange}
        basis="valid"
        onBasisChange={vi.fn()}
        resetToken={1}
      />,
    );

    expect(slider.value).toBe(slider.max);
    expect(screen.getByRole("button", { name: "↺ última semana" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("omitting resetToken keeps the existing (backward-compatible) behavior — no forced reset", () => {
    render(
      <TimeScrubber
        since={SINCE}
        until={UNTIL}
        onChange={vi.fn()}
        basis="valid"
        onBasisChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "↺ última semana" }));
    const slider = screen.getByRole("slider") as HTMLInputElement;
    expect(Number(slider.value)).toBeLessThan(Number(slider.max));
  });
});

describe("TimeScrubber — QA fix: 'Ahora' is an escape hatch for a stuck asOf (cowork ronda 3 §5)", () => {
  it("enables 'Ahora' at the live edge when the parent still holds a temporal frame, and clicking clears it", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <TimeScrubber
        since={SINCE}
        until={UNTIL}
        onChange={onChange}
        basis="valid"
        onBasisChange={vi.fn()}
      />,
    );
    // At the live edge with no external temporal state → nothing to clear.
    expect(screen.getByRole("button", { name: "Volver al último evento" })).toBeDisabled();

    // The parent's asOf LINGERS (a stuck delta) while the slider shows live — the
    // exact desync the reviewer could only escape by reloading the page.
    rerender(
      <TimeScrubber
        since={SINCE}
        until={UNTIL}
        onChange={onChange}
        basis="valid"
        onBasisChange={vi.fn()}
        temporalActive={true}
      />,
    );
    expect(screen.getByRole("button", { name: "Volver al último evento" })).toBeEnabled();

    onChange.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Volver al último evento" }));
    // Clicking guarantees a live emit even though the index was already at live —
    // the parent clears asOf → the live delta is restored (no reload needed).
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("keeps 'Ahora' disabled at live when there is no temporal state to clear (default)", () => {
    render(
      <TimeScrubber
        since={SINCE}
        until={UNTIL}
        onChange={vi.fn()}
        basis="valid"
        onBasisChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Volver al último evento" })).toBeDisabled();
  });
});

describe("TimeScrubber — QA fix: loop chips disabled for month-stepped (long) windows", () => {
  it("disables the loop chips and shows a hint when the active period steps by month (> 90 days)", () => {
    const longSince = new Date("2023-07-01T00:00:00Z");
    const longUntil = new Date("2026-07-01T00:00:00Z"); // ~3 years — month-stepped
    render(
      <TimeScrubber
        since={longSince}
        until={longUntil}
        onChange={vi.fn()}
        basis="valid"
        onBasisChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "↺ última semana" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "↺ último mes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "↺ último trimestre" })).toBeDisabled();
    expect(screen.getByText(/no están disponibles para períodos largos/)).toBeInTheDocument();
  });

  it("keeps the loop chips enabled for short (day-stepped) windows", () => {
    render(
      <TimeScrubber
        since={SINCE}
        until={UNTIL}
        onChange={vi.fn()}
        basis="valid"
        onBasisChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "↺ última semana" })).toBeEnabled();
    expect(screen.queryByText(/no están disponibles para períodos largos/)).not.toBeInTheDocument();
  });
});

describe("TimeScrubber — Simple/Detalle", () => {
  it("Simple (default) hides date ticks and the bitemporal basis toggle", () => {
    render(
      <TimeScrubber
        since={SINCE}
        until={UNTIL}
        onChange={vi.fn()}
        basis="valid"
        onBasisChange={vi.fn()}
      />,
    );
    expect(screen.queryByText("Cuándo ocurrió")).not.toBeInTheDocument();
  });

  it("Detalle shows the bitemporal basis toggle", () => {
    render(
      <TimeScrubber
        since={SINCE}
        until={UNTIL}
        onChange={vi.fn()}
        basis="valid"
        onBasisChange={vi.fn()}
        scrubDetail={true}
      />,
    );
    expect(screen.getByText("Cuándo ocurrió")).toBeInTheDocument();
    expect(screen.getByText("Según lo conocido al momento")).toBeInTheDocument();
  });
});

describe("TimeScrubber — shared-asOf mount does not flash live (WARNING 5)", () => {
  it("does not emit the pre-seek live (null) when an initialAsOf is pending", () => {
    const onChange = vi.fn();
    render(
      <TimeScrubber
        since={SINCE}
        until={UNTIL}
        onChange={onChange}
        basis="valid"
        onBasisChange={vi.fn()}
        initialAsOf={new Date("2026-06-15T00:00:00Z")}
      />,
    );
    // The mount emission is the restored day, never a transient live (null) — a
    // null would flash the parent's ?asOf URL and yield a live copy-during-flash.
    expect(onChange).toHaveBeenCalled();
    const firstArg = onChange.mock.calls[0][0] as Date | null;
    expect(firstArg).not.toBeNull();
    expect(firstArg?.toISOString().slice(0, 10)).toBe("2026-06-15");
    expect(onChange.mock.calls.every((c) => c[0] !== null)).toBe(true);
  });

  it("still emits live (null) on a normal mount (no initialAsOf)", () => {
    const onChange = vi.fn();
    render(
      <TimeScrubber
        since={SINCE}
        until={UNTIL}
        onChange={onChange}
        basis="valid"
        onBasisChange={vi.fn()}
      />,
    );
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("emits live (null) when initialAsOf falls outside the window (clamped, no restore)", () => {
    const onChange = vi.fn();
    render(
      <TimeScrubber
        since={SINCE}
        until={UNTIL}
        onChange={onChange}
        basis="valid"
        onBasisChange={vi.fn()}
        initialAsOf={new Date("2025-01-01T00:00:00Z")}
      />,
    );
    expect(onChange).toHaveBeenCalledWith(null);
  });
});

describe("TimeScrubber — bitemporal basis explanation (T5.11)", () => {
  // T5.11: only the transaction branch used to explain the two temporal bases;
  // the DEFAULT (occurrence) branch said nothing, so an operator who never
  // toggled had no way to learn which basis the replay was using. Both
  // branches now state the distinction once, tersely.
  it("the default (occurrence) branch states its basis and the register-date gap", () => {
    render(
      <TimeScrubber
        since={SINCE}
        until={UNTIL}
        onChange={vi.fn()}
        basis="valid"
        onBasisChange={vi.fn()}
        scrubDetail
      />,
    );
    expect(
      screen.getByText(
        /Reproduciendo por fecha de ocurrencia \(cuándo sucedió el hecho\); la fecha de registro puede ser posterior\./,
      ),
    ).toBeInTheDocument();
  });

  it("the transaction branch keeps its own basis sentence", () => {
    render(
      <TimeScrubber
        since={SINCE}
        until={UNTIL}
        onChange={vi.fn()}
        basis="transaction"
        onBasisChange={vi.fn()}
        scrubDetail
      />,
    );
    expect(screen.getByText(/Reproduciendo por fecha de registro/)).toBeInTheDocument();
  });
});
