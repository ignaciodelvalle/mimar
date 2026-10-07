// <PendingIncomingBanner> — the three states the pages rely on: something
// pending (every row carries who, which animal, the dates or the deadline, and
// a link to the screen where the answer is given), nothing pending, and a read
// that failed (`null`). The last two must render NOTHING.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { PendingIncoming, PendingIncomingItem } from "@/app/(app)/_lib/pending-incoming";

import { PENDING_INCOMING_MAX_ROWS, PendingIncomingBanner } from "./PendingIncomingBanner";

// Noon in Buenos Aires, so no AR-midnight rollover moves a day under the test.
const NOW = new Date("2026-10-06T15:00:00Z");

const INVITATION: PendingIncomingItem = {
  kind: "caretaker",
  token: "CTG-PAMP-0001",
  href: "/cuidado/CTG-PAMP-0001",
  petName: "Pampita",
  petSpecies: "ferret",
  counterpartyName: "Graciela",
  startsAt: new Date("2026-10-07T15:00:00Z"),
  endsAt: new Date("2026-10-14T15:00:00Z"),
};

const OFFER: PendingIncomingItem = {
  kind: "transfer",
  token: "PTR-TANG-0001",
  href: "/transferencias/PTR-TANG-0001",
  petName: "Tango",
  petSpecies: "dog",
  counterpartyName: "Graciela",
  expiresAt: new Date("2026-10-12T15:00:00Z"),
};

function render(pending: PendingIncoming | null): string {
  return renderToStaticMarkup(<PendingIncomingBanner pending={pending} now={NOW} />);
}

/** Visible text, tags stripped and whitespace collapsed. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

describe("<PendingIncomingBanner>", () => {
  it("names who asked, the animal and its species, the dates — and links the invitation", () => {
    const html = render({ items: [INVITATION] });

    expect(html).toContain('data-section="pending-incoming-banner"');
    expect(text(html)).toContain(
      "Graciela te pidió que cuides a Pampita (Hurón) del 07/10 al 14/10.",
    );
    expect(html).toContain('href="/cuidado/CTG-PAMP-0001"');
    expect(text(html)).toContain("Ver invitación");
  });

  it("an offer of titularidad says who, which animal and the day it lapses", () => {
    const html = render({ items: [OFFER] });

    expect(text(html)).toContain("Graciela quiere transferirte a Tango (Perro). Vence el 12/10.");
    expect(html).toContain('href="/transferencias/PTR-TANG-0001"');
    expect(text(html)).toContain("Ver transferencia");
  });

  it("without a display name it says so in the passive, never with an address", () => {
    const html = render({
      items: [
        { ...INVITATION, counterpartyName: null },
        { ...OFFER, counterpartyName: null },
      ],
    });

    expect(text(html)).toContain("Te pidieron que cuides a Pampita");
    expect(text(html)).toContain("Te quieren transferir a Tango");
    expect(html).not.toContain("@");
  });

  it("counts the rows in the heading when there is more than one", () => {
    expect(text(render({ items: [INVITATION, OFFER] }))).toContain(
      "Esperan tu respuesta · 2 pedidos",
    );
    // One row: the bare heading, no count — the heading ends where the row's label begins.
    expect(render({ items: [INVITATION] })).toContain(">Esperan tu respuesta</h2>");
  });

  it("caps the rows and hands the rest to /transferencias", () => {
    const many = Array.from({ length: PENDING_INCOMING_MAX_ROWS + 2 }, (_, i) => ({
      ...INVITATION,
      token: `CTG-${i}`,
      href: `/cuidado/CTG-${i}`,
    }));
    const html = render({ items: many });

    expect(html.match(/href="\/cuidado\//g)).toHaveLength(PENDING_INCOMING_MAX_ROWS);
    expect(html).toContain('href="/transferencias"');
    expect(text(html)).toContain("Ver 2 pedidos más en Transferencias");
  });

  it("renders nothing when nothing is pending", () => {
    expect(render({ items: [] })).toBe("");
  });

  it("renders nothing when the read failed — the page must never wait on a banner", () => {
    expect(render(null)).toBe("");
  });
});
