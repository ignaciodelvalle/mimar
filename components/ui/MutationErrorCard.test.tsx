// @vitest-environment jsdom
//
// MutationErrorCard — retry UI + backoff (degraded-states 2026-08-06).
//
// Covers: hidden by default; card anatomy on transientFailure; "Reintentar
// envío" replays the SAME form (requestSubmit — same hidden idempotency key);
// backoff (disabled RETRY_DISABLE_MS after each press); attempt cap
// (RETRY_MAX_ATTEMPTS) falling back to D.12-shaped go-look-first copy; and
// backoff reset once the failure clears.

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MUTATION_RETRY_COPY,
  RETRY_DISABLE_MS,
  RETRY_MAX_ATTEMPTS,
} from "@/lib/ui/degraded-states";
import { MutationErrorCard } from "./MutationErrorCard";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function makeFormRef(): { ref: RefObject<HTMLFormElement | null>; requestSubmit: () => void } {
  const form = document.createElement("form");
  const requestSubmit = vi.fn();
  form.requestSubmit = requestSubmit;
  return { ref: { current: form }, requestSubmit };
}

describe("<MutationErrorCard>", () => {
  it("renders nothing without a transient failure", () => {
    const { ref } = makeFormRef();
    const { container } = render(
      <MutationErrorCard transientFailure={undefined} error={null} formRef={ref} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the red card with title, cause and the retry button on failure", () => {
    const { ref } = makeFormRef();
    render(<MutationErrorCard transientFailure error={MUTATION_RETRY_COPY.cause} formRef={ref} />);
    expect(screen.getByText(MUTATION_RETRY_COPY.title)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(MUTATION_RETRY_COPY.cause);
    expect(screen.getByRole("button", { name: MUTATION_RETRY_COPY.retry })).toBeEnabled();
  });

  it("replays the SAME form via requestSubmit (hidden idempotency key untouched)", () => {
    const { ref, requestSubmit } = makeFormRef();
    render(<MutationErrorCard transientFailure error="x" formRef={ref} />);
    fireEvent.click(screen.getByRole("button", { name: MUTATION_RETRY_COPY.retry }));
    expect(requestSubmit).toHaveBeenCalledTimes(1);
  });

  it("backs off: disabled for RETRY_DISABLE_MS after a press, then re-enabled", () => {
    const { ref, requestSubmit } = makeFormRef();
    render(<MutationErrorCard transientFailure error="x" formRef={ref} />);
    const button = screen.getByRole("button", { name: MUTATION_RETRY_COPY.retry });

    fireEvent.click(button);
    expect(button).toBeDisabled();

    // A rapid second press is a no-op — no duplicate request fires.
    fireEvent.click(button);
    expect(requestSubmit).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(RETRY_DISABLE_MS);
    });
    expect(button).toBeEnabled();
  });

  it("caps attempts at RETRY_MAX_ATTEMPTS, then shows D.12-shaped go-look-first copy", () => {
    const { ref, requestSubmit } = makeFormRef();
    render(<MutationErrorCard transientFailure error="x" formRef={ref} />);

    for (let i = 0; i < RETRY_MAX_ATTEMPTS; i++) {
      fireEvent.click(screen.getByRole("button", { name: MUTATION_RETRY_COPY.retry }));
      act(() => {
        vi.advanceTimersByTime(RETRY_DISABLE_MS);
      });
    }

    expect(requestSubmit).toHaveBeenCalledTimes(RETRY_MAX_ATTEMPTS);
    // No more retry affordance — the honest instruction is to go LOOK first.
    expect(screen.queryByRole("button", { name: MUTATION_RETRY_COPY.retry })).toBeNull();
    expect(screen.getByText(MUTATION_RETRY_COPY.exhausted)).toBeInTheDocument();
    expect(MUTATION_RETRY_COPY.exhausted).toContain("Revisá la libreta");
  });

  it("resets the backoff once the failure clears (a later failure starts fresh)", () => {
    const { ref } = makeFormRef();
    const { rerender } = render(<MutationErrorCard transientFailure error="x" formRef={ref} />);

    for (let i = 0; i < RETRY_MAX_ATTEMPTS; i++) {
      fireEvent.click(screen.getByRole("button", { name: MUTATION_RETRY_COPY.retry }));
      act(() => {
        vi.advanceTimersByTime(RETRY_DISABLE_MS);
      });
    }
    expect(screen.queryByRole("button", { name: MUTATION_RETRY_COPY.retry })).toBeNull();

    // Failure resolves (e.g. a validation error replaces it) → card unmounts.
    rerender(<MutationErrorCard transientFailure={false} error={null} formRef={ref} />);
    expect(screen.queryByText(MUTATION_RETRY_COPY.title)).toBeNull();

    // A NEW transient failure gets a fresh retry budget.
    rerender(<MutationErrorCard transientFailure error="y" formRef={ref} />);
    expect(screen.getByRole("button", { name: MUTATION_RETRY_COPY.retry })).toBeEnabled();
  });
});
