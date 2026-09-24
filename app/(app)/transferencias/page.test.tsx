// @vitest-environment jsdom
//
// `/transferencias` hub — the Cuidados section (T4-M4).
//
// WHAT THIS FILE HAS TO PROVE
// ---------------------------------------------------------------------------
// Before this section existed, a caretaker invitation was reachable ONLY
// through the e-mail/notification link naming `/cuidado/{grantToken}` — there
// was nowhere in the app to go LOOKING for one. This file pins:
//
//   1. A pending incoming invitation renders with the pet, who invited, and
//      what accepting means (the server's own `scopeSentence` — never a copy
//      this component invents).
//   2. It links to the EXISTING `/cuidado/{grantToken}` page, which already
//      carries the accept/reject controls — this section does not duplicate
//      that consent flow.
//   3. An accepted incoming grant renders under "Cuidados activos" and NOT
//      under "Invitaciones a cuidar" — the two are different facts.
//   4. `listCaretakerGrantsForUser` is called with the SAME caller identity
//      (`userId`, `callerEmail`, `callerEmailConfirmed`) the transfers half
//      already uses — one authenticated session, not two different callers.
//   5. With nothing pending, the section says so honestly instead of vanishing
//      (mirrors the existing transfers-empty rule on this same page).
//
// The repository modules are mocked to a stub object: what is under test is
// this PAGE composing the read use-cases' output, not the SQL predicate — that
// is `__tests__/caretaker-grants-hub-visibility.test.ts`'s job, against a real
// database.

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "00000000-0000-0000-0000-0000000c0001";
const USER_EMAIL = "invitee@example.com";

const control = vi.hoisted(() => ({
  transfers: { incoming: { pending: [], history: [] }, outgoing: [] } as Record<string, unknown>,
  caretakerGrants: { incoming: [], outgoing: [] } as Record<string, unknown>,
  listTransfersArgs: [] as unknown[],
  listCaretakerGrantsArgs: [] as unknown[],
}));

vi.mock("@/lib/infra/auth-guards", () => ({
  requireUserOrRedirect: async () => ({
    supabase: {
      auth: {
        getUser: async () => ({
          data: {
            user: { email: USER_EMAIL, email_confirmed_at: "2026-01-01T00:00:00.000Z" },
          },
        }),
      },
    },
    user: { id: USER_ID },
  }),
}));

vi.mock("@/src/modules/transfers/application/list-transfers-for-user", () => ({
  listTransfersForUser: async (input: unknown) => {
    control.listTransfersArgs.push(input);
    return control.transfers;
  },
}));
vi.mock("@/src/modules/transfers/infrastructure/transfers-repository", () => ({
  TransfersRepository: {},
}));

vi.mock("@/src/modules/caretakers/application/list-caretaker-grants-for-user", () => ({
  listCaretakerGrantsForUser: async (input: unknown) => {
    control.listCaretakerGrantsArgs.push(input);
    return control.caretakerGrants;
  },
}));
vi.mock("@/src/modules/caretakers/infrastructure/caretakers-repository", () => ({
  CaretakersRepository: {},
}));

import TransferenciasHubPage from "./page";

function aCaretakerGrant(over: Record<string, unknown> = {}) {
  return {
    grantToken: "CG-abcd1234",
    status: "pending",
    direction: "incoming",
    petId: "pet-1",
    petName: "Pampa",
    petToken: "DIM-PAMP-0001",
    petSpecies: "dog",
    counterpartyName: "Ana",
    caretakerEmail: USER_EMAIL,
    startsAt: new Date("2026-08-20T10:00:00.000Z"),
    endsAt: new Date("2026-08-27T10:00:00.000Z"),
    note: null,
    expired: false,
    scopeSentence: "Podés cargar eventos. No podés transferir la titularidad.",
    canAccept: true,
    canReject: true,
    canCancel: false,
    canRevoke: false,
    ...over,
  };
}

beforeEach(() => {
  control.transfers = { incoming: { pending: [], history: [] }, outgoing: [] };
  control.caretakerGrants = { incoming: [], outgoing: [] };
  control.listTransfersArgs = [];
  control.listCaretakerGrantsArgs = [];
});

afterEach(() => cleanup());

describe("Cuidados — invitaciones de cuidado temporal en el hub", () => {
  it("shows a pending invitation with the pet, who invited, and what accepting means", async () => {
    control.caretakerGrants = { incoming: [aCaretakerGrant()], outgoing: [] };
    render(await TransferenciasHubPage());

    expect(screen.getByText("Pampa")).toBeInTheDocument();
    expect(screen.getByText(/Te invitó: Ana/)).toBeInTheDocument();
    expect(
      screen.getByText("Podés cargar eventos. No podés transferir la titularidad."),
    ).toBeInTheDocument();
  });

  it("links the invitation to the existing /cuidado/{grantToken} page — no second accept/reject flow here", async () => {
    control.caretakerGrants = {
      incoming: [aCaretakerGrant({ grantToken: "CG-xyz789" })],
      outgoing: [],
    };
    render(await TransferenciasHubPage());

    const link = screen.getByText("Pampa").closest("a");
    expect(link).toHaveAttribute("href", "/cuidado/CG-xyz789");
  });

  it("says so honestly when there is nothing pending, instead of hiding the section", async () => {
    render(await TransferenciasHubPage());
    expect(
      screen.getByText("No tenés invitaciones a cuidar mascotas pendientes."),
    ).toBeInTheDocument();
  });

  it("shows an accepted grant under Cuidados activos, and not among the invitations", async () => {
    control.caretakerGrants = {
      incoming: [aCaretakerGrant({ status: "accepted", grantToken: "CG-active01" })],
      outgoing: [],
    };
    render(await TransferenciasHubPage());

    expect(screen.getByText("Cuidados activos")).toBeInTheDocument();
    // The invitations subsection is still drawn, but empty — this row answered
    // already and is a different fact from a pending one.
    expect(
      screen.getByText("No tenés invitaciones a cuidar mascotas pendientes."),
    ).toBeInTheDocument();
  });

  it("does not draw Cuidados activos when nothing is active — an empty heading is furniture", async () => {
    render(await TransferenciasHubPage());
    expect(screen.queryByText("Cuidados activos")).not.toBeInTheDocument();
  });

  it("reads the caretaker-grants hub with the SAME verified session identity as transfers", async () => {
    render(await TransferenciasHubPage());

    expect(control.listCaretakerGrantsArgs).toHaveLength(1);
    expect(control.listTransfersArgs).toHaveLength(1);
    const caretakerArgs = control.listCaretakerGrantsArgs[0] as Record<string, unknown>;
    const transferArgs = control.listTransfersArgs[0] as Record<string, unknown>;
    expect(caretakerArgs).toEqual(transferArgs);
    expect(caretakerArgs).toEqual({
      userId: USER_ID,
      callerEmail: USER_EMAIL,
      callerEmailConfirmed: true,
    });
  });
});
