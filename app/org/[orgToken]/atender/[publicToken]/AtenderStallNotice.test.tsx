// @vitest-environment jsdom
// A14 / D.12 — the vet must never be left on an eternal "Registrando…".
//
// The defect these tests pin: the atender action commits, the post-action
// navigation is dropped, `isPending` never clears, and the vet — with no
// confirmation of any kind — signs again. Under invariant #2 that duplicate row
// in a legally-weighted health record is permanent.
//
// What is asserted here is exactly the D.12 contract, including its NEGATIVE
// half, which is the part that is easy to regress: the notice must not appear
// while the submit is still legitimately in flight, must not appear at all when
// the action answered, and must never claim the signature failed or succeeded.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ACTION_STALL_MS } from "@/lib/ui/action-stall";

import { AtenderStallNotice } from "./AtenderStallNotice";

/** A submit control in the pending shape LnSheetFooter renders. */
function PendingForm({ busy }: { busy: boolean }) {
  return (
    <form onSubmit={(e) => e.preventDefault()}>
      <button type="submit" aria-busy={busy || undefined} disabled={busy}>
        {busy ? "Registrando…" : "Registrar"}
      </button>
    </form>
  );
}

const HREF = "/org/DIM-A9PJ-B5T7/atender/DIM-DEMO-0002";

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => vi.useRealTimers());

function submit(container: HTMLElement) {
  const form = container.querySelector("form");
  if (!form) throw new Error("no form");
  fireEvent.submit(form);
}

/** The notice is set from a setTimeout callback, so the flush has to be act()ed
 *  or React never commits it and the assertion reads a stale tree. */
function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("AtenderStallNotice", () => {
  it("says nothing before a submit", () => {
    render(
      <AtenderStallNotice href={HREF}>
        <PendingForm busy={false} />
      </AtenderStallNotice>,
    );
    advance(ACTION_STALL_MS * 3);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("stays quiet while the submit is still legitimately in flight", () => {
    const { container } = render(
      <AtenderStallNotice href={HREF}>
        <PendingForm busy={true} />
      </AtenderStallNotice>,
    );
    submit(container);
    advance(ACTION_STALL_MS - 1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("declares the signature UNCONFIRMED once the submit outlives the budget", () => {
    const { container } = render(
      <AtenderStallNotice href={HREF}>
        <PendingForm busy={true} />
      </AtenderStallNotice>,
    );
    submit(container);
    advance(ACTION_STALL_MS);

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("No pudimos confirmar la firma");
    // The whole point: send them to LOOK before signing again.
    expect(alert.textContent).toMatch(/revisá la libreta/i);
    expect(alert.textContent).toMatch(/duplica/i);
  });

  it("never claims the signature failed, and never claims it succeeded", () => {
    const { container } = render(
      <AtenderStallNotice href={HREF}>
        <PendingForm busy={true} />
      </AtenderStallNotice>,
    );
    submit(container);
    advance(ACTION_STALL_MS);

    const text = screen.getByRole("alert").textContent ?? "";
    // It usually SUCCEEDED — saying "failed" would send the vet straight into
    // the duplicate this whole change exists to prevent.
    expect(text).not.toMatch(/no se pudo registrar|falló|error/i);
    // And we genuinely do not know that it worked either.
    expect(text).not.toMatch(/registrad[oa] con éxito|listo|guardado correctamente/i);
  });

  it("offers a plain document link, not a next/link transition, and never a retry", () => {
    const { container } = render(
      <AtenderStallNotice href={HREF}>
        <PendingForm busy={true} />
      </AtenderStallNotice>,
    );
    submit(container);
    advance(ACTION_STALL_MS);

    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe(HREF);
    // No auto-retry: nothing in the notice submits anything.
    expect(screen.getByRole("alert").querySelector("button")).toBeNull();
  });

  it("stays quiet when the action ANSWERED — a settled form is not a stall", () => {
    const { container, rerender } = render(
      <AtenderStallNotice href={HREF}>
        <PendingForm busy={true} />
      </AtenderStallNotice>,
    );
    submit(container);
    // The action came back (success-before-navigation, or a validation error):
    // the control leaves its pending state before the budget runs out.
    rerender(
      <AtenderStallNotice href={HREF}>
        <PendingForm busy={false} />
      </AtenderStallNotice>,
    );
    advance(ACTION_STALL_MS * 2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("retracts the verdict when the vet submits again", () => {
    const { container } = render(
      <AtenderStallNotice href={HREF}>
        <PendingForm busy={true} />
      </AtenderStallNotice>,
    );
    submit(container);
    advance(ACTION_STALL_MS);
    expect(screen.queryByRole("alert")).not.toBeNull();

    submit(container);
    expect(screen.queryByRole("alert")).toBeNull();
    advance(ACTION_STALL_MS);
    expect(screen.queryByRole("alert")).not.toBeNull();
  });
});
