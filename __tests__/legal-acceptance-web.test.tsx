// @vitest-environment jsdom
//
// The web re-acceptance screen (/aceptar-condiciones, 2026-10-07; legal review
// 2026-10-02 rows P10/P11; PO decision D2 = b, conservative interim).
//
//   · the form carries the same three required boxes as signup, none ticked,
//     and the version THIS render displays;
//   · the action authenticates with the guard (never a body id), turns the
//     checkbox encoding into booleans, and answers a full-page destination
//     (contract N3) or an es-AR refusal.

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  live: { ok: true, user: { id: "user-1", email: "ana@example.com" } } as unknown,
  result: { ok: true, recorded: true, user: {} } as unknown,
  calls: [] as unknown[],
}));

vi.mock("@/lib/infra/live-user", () => ({
  requireLiveUser: async () => control.live,
}));
vi.mock("@/src/modules/auth/application/accept-legal-terms", () => ({
  acceptLegalTermsForUser: async (input: unknown) => {
    control.calls.push(input);
    return control.result;
  },
}));
vi.mock("@/app/actions/legal-acceptance", () => ({
  acceptLegalTermsAction: async () => ({ error: null }),
}));

import { LegalAcceptanceForm } from "@/app/(auth)/aceptar-condiciones/LegalAcceptanceForm";
import { acceptLegalTermsAction } from "@/src/modules/auth/application/accept-legal-terms-action";

afterEach(cleanup);

beforeEach(() => {
  control.live = { ok: true, user: { id: "user-1", email: "ana@example.com" } };
  control.result = { ok: true, recorded: true, user: {} };
  control.calls = [];
});

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const ALL_TICKED = {
  tosAccepted: "on",
  transferAccepted: "on",
  adultDeclared: "on",
  legalVersion: "2026-10-07",
};

describe("LegalAcceptanceForm", () => {
  it("renders the three boxes, required and unticked, and the displayed version", () => {
    const view = render(<LegalAcceptanceForm returnTo="/mis-mascotas" />);
    for (const name of ["tosAccepted", "transferAccepted", "adultDeclared"]) {
      const box = view.container.querySelector(`input[name="${name}"]`) as HTMLInputElement;
      expect(box, `${name} missing`).not.toBeNull();
      expect(box.required).toBe(true);
      expect(box.checked).toBe(false);
    }
    const version = view.container.querySelector('input[name="legalVersion"]') as HTMLInputElement;
    expect(version.value).toBe("2026-10-07");
    const returnTo = view.container.querySelector('input[name="returnTo"]') as HTMLInputElement;
    expect(returnTo.value).toBe("/mis-mascotas");
    expect(
      view.container
        .querySelector('input[name="transferAccepted"]')
        ?.closest("fieldset")
        ?.querySelector("legend")?.textContent,
    ).toBe("Transferencia internacional de tus datos");
  });
});

describe("acceptLegalTermsAction", () => {
  it("passes the GUARD's user and the three booleans to the use-case", async () => {
    const state = await acceptLegalTermsAction(
      { error: null },
      form({ ...ALL_TICKED, userId: "someone-else", returnTo: "/mis-mascotas" }),
    );
    expect(control.calls).toEqual([
      {
        userId: "user-1",
        email: "ana@example.com",
        tosAccepted: true,
        transferAccepted: true,
        adultDeclared: true,
        legalVersion: "2026-10-07",
      },
    ]);
    expect(state).toEqual({ error: null, redirectTo: "/mis-mascotas" });
  });

  it("refuses an unsafe returnTo and lands on the owner home instead", async () => {
    const state = await acceptLegalTermsAction(
      { error: null },
      form({ ...ALL_TICKED, returnTo: "//evil.example" }),
    );
    expect(state).toEqual({ error: null, redirectTo: "/inicio" });
  });

  it("an unticked box reaches the use-case as false (no defaulting at the edge)", async () => {
    control.result = { ok: false, error: "NOT_ACCEPTED" };
    const { transferAccepted: _omitted, ...rest } = ALL_TICKED;
    const state = await acceptLegalTermsAction({ error: null }, form(rest));
    expect((control.calls[0] as { transferAccepted: boolean }).transferAccepted).toBe(false);
    expect(state.error).toBe("Para seguir tenés que marcar las tres casillas.");
  });

  it("refuses without a live session and calls nothing", async () => {
    control.live = { ok: false, reason: "NO_SESSION" };
    const state = await acceptLegalTermsAction({ error: null }, form(ALL_TICKED));
    expect(state.error).toMatch(/Volvé a iniciar sesión/);
    expect(control.calls).toEqual([]);
  });
});
