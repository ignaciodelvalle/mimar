// @vitest-environment jsdom
//
// ConsoleNoticeStack — WP2 notice cap.
//
// What these tests defend:
//
//   1. AT MOST ONE NOTICE BY DEFAULT. Two simultaneous board-state notices
//      must not stack above the KPI strip; the lower-priority one waits
//      behind a "+N avisos" affordance.
//   2. NOTHING IS SILENTLY SUPPRESSED. Expanding reveals the hidden notice —
//      including the personalizada notice's "Volver a" action, the reason
//      mutual exclusion was rejected.
//   3. A LONE NOTICE RENDERS PLAIN. No expander chrome when there is nothing
//      to hide.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConsoleNoticeStack } from "@/components/panorama/ConsoleNoticeStack";

afterEach(cleanup);

const noop = () => {};

function renderStack(over: Partial<Parameters<typeof ConsoleNoticeStack>[0]> = {}) {
  return render(
    <ConsoleNoticeStack
      restored={false}
      onDismissRestored={noop}
      periodResetLabel={null}
      onDismissPeriodReset={noop}
      personalizadaLabel={null}
      onVolver={noop}
      onDismissPersonalizada={noop}
      {...over}
    />,
  );
}

describe("ConsoleNoticeStack — WP2 notice cap", () => {
  it("caps two simultaneous notices to the primary plus a +1 aviso affordance", () => {
    renderStack({ restored: true, periodResetLabel: "90 días" });

    expect(screen.getByText(/Continuando tu vista anterior/)).toBeInTheDocument();
    expect(screen.queryByText(/El período volvió a/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /\+1 aviso/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("expanding reveals the hidden notice and removes the affordance", () => {
    renderStack({ restored: true, periodResetLabel: "90 días" });

    fireEvent.click(screen.getByRole("button", { name: /\+1 aviso/ }));

    expect(screen.getByText(/El período volvió a 90 días con la vista/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /\+\d+ aviso/ })).not.toBeInTheDocument();
  });

  it("all three notices collapse to one visible plus +2 avisos", () => {
    renderStack({ restored: true, periodResetLabel: "90 días", personalizadaLabel: "Bienestar" });

    expect(screen.getByText(/Continuando tu vista anterior/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /\+2 avisos/ })).toBeInTheDocument();
  });

  it("a lone notice renders without any expander chrome", () => {
    renderStack({ periodResetLabel: "90 días" });

    expect(screen.getByText(/El período volvió a 90 días con la vista/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /\+\d+ aviso/ })).not.toBeInTheDocument();
  });

  it("re-arms the cap once the stack empties (review F3)", () => {
    const { rerender } = renderStack({ restored: true, periodResetLabel: "90 días" });
    fireEvent.click(screen.getByRole("button", { name: /\+1 aviso/ }));
    expect(screen.getByText(/El período volvió a/)).toBeInTheDocument();

    // Every notice clears...
    rerender(
      <ConsoleNoticeStack
        restored={false}
        onDismissRestored={noop}
        periodResetLabel={null}
        onDismissPeriodReset={noop}
        personalizadaLabel={null}
        onVolver={noop}
        onDismissPersonalizada={noop}
      />,
    );

    // ...and a FUTURE co-occurrence is capped again — the stack lives for the
    // console's lifetime, so a sticky showAll would defeat the cap forever.
    rerender(
      <ConsoleNoticeStack
        restored={true}
        onDismissRestored={noop}
        periodResetLabel="30 días"
        onDismissPeriodReset={noop}
        personalizadaLabel={null}
        onVolver={noop}
        onDismissPersonalizada={noop}
      />,
    );
    expect(screen.queryByText(/El período volvió a/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /\+1 aviso/ })).toBeInTheDocument();
  });

  it("the personalizada notice keeps its Volver a action reachable after expanding", () => {
    const onVolver = vi.fn();
    renderStack({ restored: true, personalizadaLabel: "Bienestar", onVolver });

    fireEvent.click(screen.getByRole("button", { name: /\+1 aviso/ }));
    fireEvent.click(screen.getByRole("button", { name: /Volver a Bienestar/ }));

    expect(onVolver).toHaveBeenCalledTimes(1);
  });
});
