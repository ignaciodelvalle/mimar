// @vitest-environment jsdom
//
// SharesManager's "expiresInDays" radio group was CONTROLLED
// (`checked={expiresInDays === opt.days}`) — the counter-intuitive pair
// measured in __tests__/react19-form-reset-contract.test.tsx: a controlled
// checkbox/radio falls back to the value it had AT MOUNT on the reset that
// follows a rejected submit, discarding the duration the person actually
// picked (mount default: 30 days). "label" is genuinely controlled
// (value+onChange) and already survives on its own.
//
// Real submit via `form.requestSubmit()` — see
// __tests__/react19-form-reset-contract.test.tsx for why a dispatched event
// does not exercise React 19's reset.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createMock = vi.fn();
vi.mock("@/app/actions/libreta-share", () => ({
  createLibretaShareAction: (...args: unknown[]) => createMock(...args),
  revokeLibretaShareAction: vi.fn(),
}));

import { SharesManager } from "./SharesManager";

beforeEach(() => {
  createMock.mockReset();
});

afterEach(cleanup);

describe("<SharesManager> — survives the React 19 post-error reset", () => {
  it("keeps the picked expiration after a rejected submit", async () => {
    createMock.mockResolvedValue({ error: "No se pudo crear el enlace." });
    const { container } = render(<SharesManager petPublicToken="DIM-TEST-0001" shares={[]} />);

    fireEvent.click(screen.getByText("Nuevo enlace"));

    const ninety = container.querySelector(
      'input[name="expiresInDays"][value="90"]',
    ) as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.click(ninety);
    expect(ninety.checked).toBe(true);

    form.requestSubmit();
    await waitFor(() => expect(createMock).toHaveBeenCalled());
    await screen.findByText("No se pudo crear el enlace.");

    expect(
      (container.querySelector('input[name="expiresInDays"][value="90"]') as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      (container.querySelector('input[name="expiresInDays"][value="30"]') as HTMLInputElement)
        .checked,
    ).toBe(false);
  });
});
