// @vitest-environment jsdom
//
// The moment of consent. Everything asserted here is something a person is
// agreeing to, so nothing here is cosmetic:
//
//   - BOTH halves of the scope are on screen before the accept button exists.
//     The spec scenario is explicit ("Podés… / No podés…"), and a component
//     that showed only the permissions would be recruiting caretakers on a
//     half-truth.
//   - KEY 2 of the two-key public-contact model starts OFF. It publishes a
//     THIRD PARTY's phone number on an unauthenticated page; a pre-ticked box
//     is not consent, it is a default nobody chose (PO decision 2, 2026-08-19).
//   - Accepting calls the action with the consent the person actually gave, and
//     does NOT navigate by hand.
//
// WHAT THIS FILE NO LONGER ASSERTS, AND WHY IT IS A CAUTIONARY TALE.
// It used to assert that accepting "lands on a success screen" — an
// LnSuccessScreen titled "Cuidás a Pampa" behind a local `accepted` flag. That
// screen could never render in production. acceptCaretakerGrantAction calls
// revalidatePath on the route the user is standing on, so the RSC tree comes
// back with the grant 'accepted', `canRespond` false, and this island unmounted
// before the flag could paint. Deterministic, not a race.
//
// It passed HERE for the same reason it failed THERE: the server action is
// mocked and there is no RSC refresh, so jsdom cannot reproduce the mechanism
// that breaks it — the "jsdom can't catch activation behaviour" family again.
// A green unit test over unreachable code is worse than no test: it is evidence
// FOR the thing that does not work. The accepted state now lives where it is
// real, on the server render, and is asserted end-to-end in
// e2e/caretaker-temporal.spec.ts.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const acceptAction = vi.fn();
const rejectAction = vi.fn();
vi.mock("@/src/modules/caretakers/actions", () => ({
  acceptCaretakerGrantAction: (...args: unknown[]) => acceptAction(...args),
  rejectCaretakerGrantAction: (...args: unknown[]) => rejectAction(...args),
}));

const navigateAfterActionSuccess = vi.fn();
vi.mock("@/lib/ui/full-page-action-nav", () => ({
  navigateAfterActionSuccess: (...args: unknown[]) => navigateAfterActionSuccess(...args),
}));

import {
  CARETAKER_SCOPE_ALLOWED,
  CARETAKER_SCOPE_DENIED,
} from "@/src/modules/caretakers/domain/grant-copy";
import { CaretakerInvitationActions } from "./CaretakerInvitationActions";

const PROPS = {
  grantToken: "CG-abc123",
  petName: "Pampa",
  titularName: "Ignacio",
  scopeSentence: `${CARETAKER_SCOPE_ALLOWED} ${CARETAKER_SCOPE_DENIED}`,
};

beforeEach(() => {
  acceptAction.mockReset().mockResolvedValue({ ok: true });
  rejectAction.mockReset().mockResolvedValue({ ok: true });
  navigateAfterActionSuccess.mockReset();
});

afterEach(() => cleanup());

describe("the scope, before there is anything to accept", () => {
  it("shows what the caretaker MAY do", () => {
    render(<CaretakerInvitationActions {...PROPS} />);
    expect(screen.getByText(CARETAKER_SCOPE_ALLOWED)).toBeInTheDocument();
  });

  it("shows what the caretaker MAY NOT do — never only the permissions", () => {
    render(<CaretakerInvitationActions {...PROPS} />);
    expect(screen.getByText(CARETAKER_SCOPE_DENIED)).toBeInTheDocument();
  });
});

describe("key 2 — the caretaker's public-contact consent", () => {
  // The checkbox lives on the CONFIRM step, next to the button that commits —
  // not on the landing view, where it would be a setting the reader skims past
  // before they have decided anything.
  it("is OFF by default", () => {
    render(<CaretakerInvitationActions {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "Aceptar el cuidado" }));
    expect(screen.getByRole("checkbox", { name: /contacto/i })).not.toBeChecked();
  });

  it("accepting without touching it sends consent = false", async () => {
    render(<CaretakerInvitationActions {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "Aceptar el cuidado" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar el cuidado" }));
    await waitFor(() =>
      expect(acceptAction).toHaveBeenCalledWith({
        grantToken: "CG-abc123",
        publicContactConsent: false,
      }),
    );
  });

  it("ticking it sends consent = true", async () => {
    render(<CaretakerInvitationActions {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "Aceptar el cuidado" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /contacto/i }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar el cuidado" }));
    await waitFor(() =>
      expect(acceptAction).toHaveBeenCalledWith({
        grantToken: "CG-abc123",
        publicContactConsent: true,
      }),
    );
  });
});

describe("after accepting", () => {
  it("hands the outcome to the server re-render instead of navigating by hand", async () => {
    // The positive assertion this file CAN honestly make about accept: the
    // action ran, and nothing here tried to move the user. The page around this
    // island is revalidated by the action itself and renders the accepted state
    // ("Estás cuidando a …"); asserting that here would mean asserting against
    // a mock of the very refresh that produces it. e2e/caretaker-temporal.spec.ts
    // owns that assertion, against the real thing.
    render(<CaretakerInvitationActions {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "Aceptar el cuidado" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar el cuidado" }));
    await waitFor(() => expect(acceptAction).toHaveBeenCalledTimes(1));
    expect(navigateAfterActionSuccess).not.toHaveBeenCalled();
  });

  it("never renders a client-side success screen — it is unreachable in production", async () => {
    // The regression pin for the deleted branch. If somebody re-adds a local
    // `accepted` success screen, this goes red and the header explains why the
    // screen cannot paint once the RSC tree comes back.
    render(<CaretakerInvitationActions {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "Aceptar el cuidado" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar el cuidado" }));
    await waitFor(() => expect(acceptAction).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Cuidás a/)).not.toBeInTheDocument();
  });

  it("surfaces the action's refusal instead of pretending it worked", async () => {
    acceptAction.mockResolvedValue({ error: "La invitación ya fue resuelta por otra acción." });
    render(<CaretakerInvitationActions {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "Aceptar el cuidado" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar el cuidado" }));
    await waitFor(() =>
      expect(
        screen.getByText("La invitación ya fue resuelta por otra acción."),
      ).toBeInTheDocument(),
    );
  });
});

describe("rejecting", () => {
  it("calls the reject action and reloads the invitation page", async () => {
    render(<CaretakerInvitationActions {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "Rechazar la invitación" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar el rechazo" }));
    await waitFor(() => expect(rejectAction).toHaveBeenCalledWith({ grantToken: "CG-abc123" }));
    await waitFor(() => expect(navigateAfterActionSuccess).toHaveBeenCalled());
  });

  it("does not send the consent when the invitation is declined", async () => {
    render(<CaretakerInvitationActions {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "Rechazar la invitación" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar el rechazo" }));
    await waitFor(() => expect(rejectAction).toHaveBeenCalled());
    expect(acceptAction).not.toHaveBeenCalled();
  });
});
