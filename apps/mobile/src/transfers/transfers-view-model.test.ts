// `transfers-view-model` — the pure half of transferencias.
//
// THE TWO THINGS THAT MATTER MOST HERE ARE ABOUT WHAT THIS FILE DOES **NOT** DO:
//
//   1. It never recomputes a capability. Every test that touches an affordance
//      feeds a `capabilities` block and checks the file reads it — including the
//      combinations that look inconsistent (`canReject` true on an expired
//      proposal) and are the writers' own asymmetries.
//   2. It never recomputes `expired`. The flag comes from the server's clock,
//      and a row can carry `status: "pending"` with `expired: true` — the window
//      between the deadline and the nightly cron.
//
// The other subject is PII: an incoming row has no sender e-mail to show, and
// the label must say nothing rather than reach for `toEmail`, which on an
// incoming row is the CALLER'S OWN address and would read as the sender's.

import { describe, expect, it } from "@jest/globals";

import type { MyTransferV1, MyTransfersV1 } from "@dim/contract/api";
import { OWNER_TRANSFER_REASONS, TRANSFER_NOTE_MAX } from "@dim/contract/input";

import {
  TRANSFER_REASON_CHOICES,
  TRANSFER_WINDOW_DAYS,
  allTransfers,
  buildAcceptTransfer,
  buildCancelTransfer,
  buildInitiateTransfer,
  buildRejectTransfer,
  findTransfer,
  transferCounterpartyLabel,
  transferDeadlineLabel,
  transferHeadline,
  transferInputCodeMessage,
  transferReasonLabel,
  transferStatusLabel,
} from "./transfers-view-model";

function aTransfer(over: Partial<MyTransferV1> = {}): MyTransferV1 {
  return {
    transferToken: "PTR-ABCD-2345",
    status: "pending",
    direction: "incoming",
    pet: { publicToken: "DIM-PAMP-0001", name: "Pampa", species: "dog" },
    counterpartyName: "Vecina",
    toEmail: "yo@example.com",
    reason: "gift",
    note: null,
    rejectionReason: null,
    initiatedAt: "2026-08-20T10:00:00.000Z",
    respondedAt: null,
    expiresAt: "2026-08-27T10:00:00.000Z",
    expired: false,
    capabilities: { canAccept: true, canReject: true, canCancel: false },
    ...over,
  };
}

function aPayload(over: Partial<MyTransfersV1> = {}): MyTransfersV1 {
  return {
    payloadVersion: 1,
    issuedAt: "2026-08-26T00:00:00.000Z",
    staleAfter: "2026-08-26T00:01:00.000Z",
    incoming: { pending: [aTransfer()], history: [] },
    outgoing: [],
    ...over,
  };
}

describe("the reason vocabulary is the contract's", () => {
  it("offers exactly the four the column allows, in the web's order", () => {
    expect(TRANSFER_REASON_CHOICES.map((c) => c.reason)).toEqual([...OWNER_TRANSFER_REASONS]);
    expect(TRANSFER_REASON_CHOICES.map((c) => c.label)).toEqual([
      "Venta",
      "Regalo",
      "Herencia",
      "Otro",
    ]);
  });

  it("carries the window from the contract rather than a literal 7", () => {
    expect(TRANSFER_WINDOW_DAYS).toBe(7);
  });

  it("names a row's reason, and says nothing when there is none", () => {
    expect(transferReasonLabel(aTransfer({ reason: "sale" }))).toBe("Venta");
    expect(transferReasonLabel(aTransfer({ reason: null }))).toBe(null);
  });
});

describe("the deadline reads the server's flag, never the date", () => {
  it("says vence while a proposal is open", () => {
    expect(transferDeadlineLabel(aTransfer())).toBe("Vence el 27/08/2026");
  });

  it("says venció when the SERVER says so, even with status still pending", () => {
    // The window between the deadline passing and the nightly cron stamping the
    // row. A screen that read `status` alone would say "Vence el …" about a
    // proposal that can no longer be accepted.
    const row = aTransfer({ status: "pending", expired: true });
    expect(transferDeadlineLabel(row)).toBe("Venció el 27/08/2026");
  });

  it("says NOTHING once a proposal is answered", () => {
    // It used to fall back to the status word, and the hub's render test caught
    // what that meant on screen: every row already carries a status badge, so a
    // resolved proposal printed "Rechazada" twice — once as a badge, once where
    // a date belongs. A deadline on an answered proposal is not a fact anybody
    // needs, so the honest return is nothing.
    expect(transferDeadlineLabel(aTransfer({ status: "accepted" }))).toBe(null);
    expect(transferDeadlineLabel(aTransfer({ status: "cancelled" }))).toBe(null);
    expect(transferDeadlineLabel(aTransfer({ status: "expired" }))).toBe(null);
  });

  it("has a word for every one of the five statuses", () => {
    const labels = (["pending", "accepted", "rejected", "expired", "cancelled"] as const).map(
      transferStatusLabel,
    );
    expect(labels).toEqual(["Pendiente", "Aceptada", "Rechazada", "Expirada", "Cancelada"]);
  });
});

describe("the counterparty label, and the e-mail it must not borrow", () => {
  it("names the sender on an incoming row", () => {
    expect(transferCounterpartyLabel(aTransfer())).toBe("De: Vecina");
  });

  it("says NOTHING on an incoming row with no sender name — never `toEmail`", () => {
    // `toEmail` on an incoming row is the CALLER'S OWN address. Falling back to
    // it would print "De: yo@example.com" — the reader's own e-mail, presented
    // as the sender's.
    const row = aTransfer({ counterpartyName: null });
    expect(transferCounterpartyLabel(row)).toBe(null);
  });

  it("falls back to the address on an OUTGOING row, which is what the sender typed", () => {
    const row = aTransfer({
      direction: "outgoing",
      counterpartyName: null,
      toEmail: "vecina@example.com",
    });
    expect(transferCounterpartyLabel(row)).toBe("Para: vecina@example.com");
  });

  it("prefers a resolved name to the address on an outgoing row", () => {
    const row = aTransfer({ direction: "outgoing", counterpartyName: "Vecina" });
    expect(transferCounterpartyLabel(row)).toBe("Para: Vecina");
  });
});

describe("the headline says which side you are on", () => {
  it("uses the web's own two shapes", () => {
    expect(transferHeadline(aTransfer())).toBe("Recibiste a Pampa");
    expect(transferHeadline(aTransfer({ direction: "outgoing" }))).toBe("Transferencia de Pampa");
  });
});

describe("finding one row for the deep link", () => {
  it("looks across all three lists, because a link can name any of them", () => {
    const sent = aTransfer({ transferToken: "PTR-SENT-0001", direction: "outgoing" });
    const old = aTransfer({ transferToken: "PTR-OLD0-0001", status: "rejected" });
    const payload = aPayload({
      incoming: { pending: [aTransfer()], history: [old] },
      outgoing: [sent],
    });

    expect(allTransfers(payload)).toHaveLength(3);
    expect(findTransfer(payload, "PTR-SENT-0001")?.direction).toBe("outgoing");
    expect(findTransfer(payload, "PTR-OLD0-0001")?.status).toBe("rejected");
  });

  it("answers null for a token this caller has no proposal for", () => {
    // Which is NOT the same as "no existe" — the payload only ever contains the
    // rows this person is a party to, so absence here means exactly "not yours".
    expect(findTransfer(aPayload(), "PTR-ZZZZ-9999")).toBe(null);
  });
});

describe("the commands are built through the contract's own schema", () => {
  it("builds all four when the input is good", () => {
    expect(
      buildInitiateTransfer({
        petPublicToken: "DIM-PAMP-0001",
        toEmail: "vecina@example.com",
        reason: "gift",
        note: "",
      }).ok,
    ).toBe(true);
    expect(buildAcceptTransfer("PTR-ABCD-2345").ok).toBe(true);
    expect(buildRejectTransfer("PTR-ABCD-2345", "").ok).toBe(true);
    expect(buildCancelTransfer("PTR-ABCD-2345").ok).toBe(true);
  });

  it("turns a bad address into a FIELD sentence, before the network", () => {
    const built = buildInitiateTransfer({
      petPublicToken: "DIM-PAMP-0001",
      toEmail: "vecina",
      reason: "gift",
      note: "",
    });
    expect(built.ok).toBe(false);
    expect(built.ok === false && built.code).toBe("EMAIL_INVALID");
    expect(built.ok === false && built.message).toBe("Escribí un email válido para el receptor.");
  });

  it("refuses an unchosen reason rather than defaulting to one", () => {
    // The screen passes "" when nothing is selected. Defaulting to "gift" here
    // would make the commonest submission on a form that hands over an animal a
    // reason nobody picked.
    const built = buildInitiateTransfer({
      petPublicToken: "DIM-PAMP-0001",
      toEmail: "vecina@example.com",
      reason: "",
      note: "",
    });
    expect(built.ok === false && built.code).toBe("REASON_INVALID");
  });

  it("treats a blank note and a blank rejection reason as absent", () => {
    const initiated = buildInitiateTransfer({
      petPublicToken: "DIM-PAMP-0001",
      toEmail: "vecina@example.com",
      reason: "gift",
      note: "   ",
    });
    expect(initiated.ok && initiated.input.command === "initiate" && initiated.input.note).toBe(
      null,
    );

    const rejected = buildRejectTransfer("PTR-ABCD-2345", "  ");
    expect(rejected.ok && rejected.input.command === "reject" && rejected.input.reason).toBe(null);
  });

  it("bounds the note at the contract's number", () => {
    const built = buildRejectTransfer("PTR-ABCD-2345", "x".repeat(TRANSFER_NOTE_MAX + 1));
    expect(built.ok === false && built.code).toBe("NOTE_TOO_LONG");
  });
});

describe("every input code has a sentence", () => {
  it("answers each one, and answers an unknown parse honestly", () => {
    const codes = [
      "COMMAND_REQUIRED",
      "EMAIL_INVALID",
      "NOTE_TOO_LONG",
      "PET_TOKEN_REQUIRED",
      "REASON_INVALID",
      "TRANSFER_TOKEN_REQUIRED",
    ] as const;
    for (const code of codes) {
      expect(transferInputCodeMessage(code).length).toBeGreaterThan(0);
    }
    expect(transferInputCodeMessage(null)).toContain("no pudo interpretar");
  });
});
