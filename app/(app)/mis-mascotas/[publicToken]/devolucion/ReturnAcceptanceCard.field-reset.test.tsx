// @vitest-environment jsdom
//
// ReturnAcceptanceCard's reject form has an uncontrolled "reason" textarea
// (no `value=`/`onChange=`, no `defaultValue=`) — a rejected submit wipes
// the rejection explanation the owner just typed. The accept form has no
// name-bearing fields, so it's out of scope for this fence.
//
// Real submit via `form.requestSubmit()` — see
// __tests__/react19-form-reset-contract.test.tsx for why a dispatched event
// does not exercise React 19's reset.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const acceptMock = vi.fn();
const rejectMock = vi.fn();
vi.mock("@/app/actions/return-to-owner-form", () => ({
  ownerAcceptReturnFormAction: Object.assign(vi.fn(), {
    bind:
      (_thisArg: unknown, petPublicToken: string) =>
      (...args: unknown[]) =>
        acceptMock(petPublicToken, ...args),
  }),
  ownerRejectReturnFormAction: Object.assign(vi.fn(), {
    bind:
      (_thisArg: unknown, petPublicToken: string) =>
      (...args: unknown[]) =>
        rejectMock(petPublicToken, ...args),
  }),
}));

import { ReturnAcceptanceCard } from "./ReturnAcceptanceCard";

const BASE_PROPS = {
  petPublicToken: "DIM-TEST-0001",
  petName: "Firulais",
  actorName: "Refugio Norte",
  proposalNotes: null,
  proposedAt: "2026-09-01T00:00:00.000Z",
  backUrl: "/mis-mascotas",
};

beforeEach(() => {
  acceptMock.mockReset();
  rejectMock.mockReset();
  acceptMock.mockResolvedValue({ error: null });
});

afterEach(cleanup);

describe("<ReturnAcceptanceCard> — survives the React 19 post-error reset", () => {
  it("keeps the typed rejection reason after a rejected submit", async () => {
    rejectMock.mockResolvedValue({ error: "No se pudo enviar el rechazo." });
    const { container } = render(<ReturnAcceptanceCard {...BASE_PROPS} />);

    fireEvent.click(screen.getByText("Rechazar propuesta"));

    const reason = container.querySelector('textarea[name="reason"]') as HTMLTextAreaElement;
    const rejectForm = reason.closest("form") as HTMLFormElement;

    fireEvent.change(reason, {
      target: { value: "El refugio no coordinó un horario de entrega." },
    });

    rejectForm.requestSubmit();
    await waitFor(() => expect(rejectMock).toHaveBeenCalled());
    await screen.findByText("No se pudo enviar el rechazo.");

    expect((container.querySelector('textarea[name="reason"]') as HTMLTextAreaElement).value).toBe(
      "El refugio no coordinó un horario de entrega.",
    );
  });
});
