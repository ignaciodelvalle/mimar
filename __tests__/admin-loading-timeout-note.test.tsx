// @vitest-environment jsdom
//
// AdminLoadingTimeoutNote — Cowork I2 (staging QA 2026-07-17).
//
// The /admin skeleton must give the operator a signal + a way out if a load
// hangs, WITHOUT flashing on normal (<12s) loads. These tests pin both halves:
// the note is absent on mount and only appears once the ~12s threshold elapses.

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminLoadingTimeoutNote } from "@/app/admin/AdminLoadingTimeoutNote";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("AdminLoadingTimeoutNote", () => {
  it("renders nothing initially (must not flash on a normal fast load)", () => {
    render(<AdminLoadingTimeoutNote />);
    expect(screen.queryByText(/tardando más de lo normal/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /reintentar/i })).toBeNull();
  });

  it("does NOT surface the note before the 12s threshold", () => {
    vi.useFakeTimers();
    render(<AdminLoadingTimeoutNote />);
    act(() => {
      vi.advanceTimersByTime(11_000);
    });
    expect(screen.queryByText(/tardando más de lo normal/i)).toBeNull();
  });

  it("surfaces the note + Reintentar button after ~12s still loading", () => {
    vi.useFakeTimers();
    render(<AdminLoadingTimeoutNote />);
    act(() => {
      vi.advanceTimersByTime(12_000);
    });
    expect(screen.getByText(/tardando más de lo normal/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /reintentar/i })).toBeTruthy();
  });
});
