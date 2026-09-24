// @vitest-environment jsdom
//
// UpdateLastSeenForm's "reason" textarea had a STATIC
// defaultValue={defaultNote} — a rejected submit put back the ORIGINAL
// note, discarding whatever the owner had just typed.
//
// Real submit via `form.requestSubmit()` — see
// __tests__/react19-form-reset-contract.test.tsx for why a dispatched event
// does not exercise React 19's reset.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ui/use-action-redirect", () => ({
  useActionRedirect: vi.fn(),
}));
vi.mock("@/lib/ui/use-idempotency-key", () => ({
  useIdempotencyKey: () => ({ key: "test-idempotency-key" }),
}));

import { UpdateLastSeenForm } from "./UpdateLastSeenForm";

afterEach(cleanup);

describe("<UpdateLastSeenForm> — survives the React 19 post-error reset", () => {
  it("keeps the typed novedades after a rejected submit", async () => {
    const action = vi.fn(async () => ({ error: "No se pudo guardar la actualización." }));
    const { container } = render(
      <UpdateLastSeenForm
        action={action}
        petName="Firulais"
        petJurisdictionProvince={null}
        petJurisdictionLocality={null}
        defaultPlaceName={null}
        defaultNote="Vista cerca de la plaza."
        defaultLat={null}
        defaultLng={null}
      />,
    );

    const reason = container.querySelector('textarea[name="reason"]') as HTMLTextAreaElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.change(reason, { target: { value: "La vio un vecino cruzando la avenida." } });

    form.requestSubmit();
    await waitFor(() => expect(action).toHaveBeenCalled());
    await screen.findByText("No se pudo guardar la actualización.");

    expect((container.querySelector('textarea[name="reason"]') as HTMLTextAreaElement).value).toBe(
      "La vio un vecino cruzando la avenida.",
    );
  });
});
