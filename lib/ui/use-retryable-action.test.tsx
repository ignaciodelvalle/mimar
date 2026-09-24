// @vitest-environment jsdom
//
// use-retryable-action — dispatch-level catch (degraded-states 2026-08-06).
//
// Covers the client half of Idempotent Mutation Retry:
//   - a rejected dispatch → `transientFailure` state, form STAYS MOUNTED and
//     typed input survives;
//   - success passes through untouched;
//   - Next.js control-flow errors (NEXT_REDIRECT) are re-thrown, never eaten;
//   - the whitelist boundary is STRUCTURAL: no idempotency key, no compile.
//
// The server half — the SAME clientIdempotencyKey replayed resolves as the
// existing record (wasNoop/redirectTo), not a duplicate — is covered by the
// live-DB suite in __tests__/idempotency-guards.test.ts (createIntake /
// createTattooForUser double-submit with one key).

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { useActionState, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MUTATION_RETRY_COPY } from "@/lib/ui/degraded-states";
import { type RetryableFormState, useRetryableAction } from "./use-retryable-action";

type State = RetryableFormState;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Harness({
  action,
  idempotencyKey = "11111111-2222-4333-8444-555555555555",
}: {
  action: (prev: State, formData: FormData) => Promise<State>;
  idempotencyKey?: string;
}) {
  const retryable = useRetryableAction(action, { idempotencyKey });
  const [state, formAction] = useActionState(retryable, { error: null });
  // CONTROLLED field — the convention every whitelisted form follows
  // (VaccinationForm/DewormingForm hold field state in useState), and the
  // reason typed input survives: React 19 resets UNCONTROLLED fields when a
  // form action settles, controlled ones re-render from state.
  const [field, setField] = useState("");
  return (
    <form action={formAction} aria-label="harness">
      <input type="hidden" name="clientIdempotencyKey" value={idempotencyKey} />
      <label>
        Campo
        <input name="field" type="text" value={field} onChange={(e) => setField(e.target.value)} />
      </label>
      <button type="submit">Enviar</button>
      <p data-testid="error">{state.error ?? ""}</p>
      <p data-testid="transient">{state.transientFailure ? "yes" : "no"}</p>
    </form>
  );
}

async function submit() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
  });
}

describe("useRetryableAction", () => {
  it("turns a rejected dispatch into a transientFailure state — form stays mounted, input intact", async () => {
    const action = vi.fn(async (): Promise<State> => {
      throw new Error("fetch failed (503)");
    });
    render(<Harness action={action} />);

    const input = screen.getByLabelText("Campo");
    fireEvent.change(input, { target: { value: "Antirrábica 2026" } });

    await submit();

    // No unmount: the same form and the typed value are still there.
    expect(screen.getByRole("form", { name: "harness" })).toBeInTheDocument();
    expect(input).toHaveValue("Antirrábica 2026");
    expect(screen.getByTestId("transient")).toHaveTextContent("yes");
    expect(screen.getByTestId("error")).toHaveTextContent(MUTATION_RETRY_COPY.cause);
  });

  it("passes a successful action result through untouched (no card state)", async () => {
    const action = vi.fn(async (): Promise<State> => ({ error: null }));
    render(<Harness action={action} />);
    await submit();

    expect(action).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("transient")).toHaveTextContent("no");
    expect(screen.getByTestId("error")).toHaveTextContent("");
  });

  it("passes a server-side validation error through untouched (not a transient failure)", async () => {
    const action = vi.fn(async (): Promise<State> => ({ error: "Fecha inválida" }));
    render(<Harness action={action} />);
    await submit();

    expect(screen.getByTestId("error")).toHaveTextContent("Fecha inválida");
    expect(screen.getByTestId("transient")).toHaveTextContent("no");
  });

  it("re-throws Next.js control-flow errors instead of swallowing them", async () => {
    const redirectErr = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/destino;307;",
    });
    const action = vi.fn(async (): Promise<State> => {
      throw redirectErr;
    });
    const { result } = renderHook(() =>
      useRetryableAction(action, { idempotencyKey: "11111111-2222-4333-8444-555555555555" }),
    );
    // The control-flow rejection must ESCAPE the wrapper (Next's router
    // consumes it) — never be converted into a transientFailure state.
    await expect(result.current({ error: null }, new FormData())).rejects.toMatchObject({
      digest: redirectErr.digest,
    });
  });

  it("throws loudly when handed an empty idempotency key (whitelist runtime guard)", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const action = async (): Promise<State> => ({ error: null });
    expect(() => render(<Harness action={action} idempotencyKey="" />)).toThrow(
      /clientIdempotencyKey/,
    );
    consoleSpy.mockRestore();
  });

  it("whitelist is structural: omitting idempotencyKey does not typecheck", () => {
    type Options = Parameters<typeof useRetryableAction>[1];
    const ok: Options = { idempotencyKey: "k" };
    expect(ok.idempotencyKey).toBe("k");
    // @ts-expect-error — a surface without a clientIdempotencyKey cannot wire retry
    const bad: Options = {};
    expect(bad).toBeDefined();
  });
});
