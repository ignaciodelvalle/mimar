// Tests for <PetActionRow> — the primary row under the credential
// (owner-pet-actions, PO 2026-10-01): Anotar · Compartir · Modo perdida, from
// the catalogue, with this platform's doors. Pattern: react-dom/server
// renderToStaticMarkup (repo convention — no jsdom).
//
// What used to be here — the "⋯ Más" overflow button and "Editar datos" on
// the row — moved to the panel below it; the row carries the three everyday
// acts and nothing else.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { type PetActionContext, derivePetActions } from "@dim/contract/reference";

import { PetActionRow } from "./PetActionRow";
import { type WebPetAction, resolveWebPetActions } from "./pet-action-web";

const TITULAR: PetActionContext = {
  viewerRole: "owner",
  isTitular: true,
  petStatus: "active",
  species: "dog",
  pppDoor: false,
};

function primary(ctx: PetActionContext): WebPetAction[] {
  return resolveWebPetActions(derivePetActions(ctx), {
    petPublicToken: "abc",
    petStatus: ctx.petStatus ?? "active",
  }).primary;
}

function anchors(html: string): string[] {
  return html.match(/<a [^>]*>/g) ?? [];
}

describe("<PetActionRow> — the three everyday acts", () => {
  it("titular of an active animal: Anotar · Compartir · Modo perdida (danger), in order", () => {
    const html = renderToStaticMarkup(<PetActionRow actions={primary(TITULAR)} />);
    const order = ["Anotar", "Compartir", "Modo perdida"];
    const positions = order.map((label) => html.indexOf(`>${label}<`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(html).toContain("sheet=anotar");
    expect(html).toContain("sheet=compartir");
    expect(html).toContain("sheet=marcar-perdida");
    // Only the lost act is the danger tone.
    expect(html.match(/ln-act--danger/g) ?? []).toHaveLength(1);
    expect(anchors(html)).toHaveLength(3);
    for (const a of anchors(html)) expect(a).toContain("ln-act");
  });

  it("no longer carries Editar datos or the Más overflow — both live in the panel now", () => {
    const html = renderToStaticMarkup(<PetActionRow actions={primary(TITULAR)} />);
    expect(html).not.toContain("Editar datos");
    expect(html).not.toContain(">Más<");
    expect(html).not.toContain("sheet=mas");
  });

  it("a LOST animal keeps Modo perdida, pointing at the case already on the page", () => {
    const html = renderToStaticMarkup(
      <PetActionRow actions={primary({ ...TITULAR, petStatus: "lost" })} />,
    );
    expect(html).toContain('href="#modo-perdida"');
    expect(html).toContain(">Modo perdida<");
  });

  it("a deceased animal: Compartir alone", () => {
    const html = renderToStaticMarkup(
      <PetActionRow actions={primary({ ...TITULAR, petStatus: "deceased" })} />,
    );
    expect(anchors(html)).toHaveLength(1);
    expect(html).toContain(">Compartir<");
    expect(html).not.toContain("Anotar");
  });

  it("an organization member: Compartir alone", () => {
    const html = renderToStaticMarkup(
      <PetActionRow
        actions={primary({ ...TITULAR, viewerRole: "org_member", isTitular: false })}
      />,
    );
    expect(anchors(html)).toHaveLength(1);
    expect(html).toContain(">Compartir<");
  });

  it("tells a screen reader what each act does", () => {
    const html = renderToStaticMarkup(<PetActionRow actions={primary(TITULAR)} />);
    expect(html).toContain('aria-describedby="pet-action-record-hint"');
    expect(html).toContain('id="pet-action-record-hint"');
    expect(html).toContain("Anotar un evento en la libreta.");
  });

  it("draws a grey act as text with its reason, never as a link", () => {
    const [record] = primary(TITULAR);
    const grey: WebPetAction = {
      ...(record as WebPetAction),
      link: null,
      caption: "Solo el titular",
    };
    const html = renderToStaticMarkup(<PetActionRow actions={[grey]} />);
    expect(anchors(html)).toHaveLength(0);
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("Solo el titular");
  });

  it("renders nothing when there is no act to offer", () => {
    expect(renderToStaticMarkup(<PetActionRow actions={[]} />)).toBe("");
  });
});
