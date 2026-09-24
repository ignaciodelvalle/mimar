// Tests for <PetActionRow> — labeled action bar matching the "Una sola
// libreta" handoff (.actionbar; PO 2026-07-05). Pattern: react-dom/server
// renderToStaticMarkup (repo convention — no jsdom).

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PetActionRow } from "./PetActionRow";

describe("<PetActionRow> — labeled buttons (handoff .actionbar)", () => {
  it("owner + active pet: Anotar · Compartir · Editar datos · Marcar como perdida (danger) · Más, in order", () => {
    const html = renderToStaticMarkup(
      <PetActionRow petPublicToken="abc" isOwner isDeceased={false} petStatus="active" />,
    );
    // Visible, labeled (not icon-only). Anotar leads — the pet-specific capture
    // shortcut (3b improvement C moved capture out of the mid-face textarea).
    for (const label of ["Anotar", "Compartir", "Editar datos", "Marcar como perdida", "Más"]) {
      expect(html).toContain(`>${label}`);
    }
    // Handoff order (Anotar prepended).
    const order = ["Anotar", "Compartir", "Editar datos", "Marcar como perdida", "Más"];
    const positions = order.map((l) => html.indexOf(`>${l}`));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // Anotar opens THIS pet's capture sheet.
    expect(html).toContain("sheet=anotar");
    // Marcar como perdida carries the danger modifier.
    expect(html).toContain("ln-act ln-act--danger");
    // Every action uses the shared .ln-act class (44px touch target lives there).
    const anchors = html.match(/<a [^>]*>/g) ?? [];
    expect(anchors.length).toBe(5);
    for (const a of anchors) expect(a).toContain("ln-act");
  });

  it("lost pet: NO Marcar como perdida/encontrada here (found CTA lives in LostCaseBlock)", () => {
    const html = renderToStaticMarkup(
      <PetActionRow petPublicToken="abc" isOwner isDeceased={false} petStatus="lost" />,
    );
    expect(html).not.toContain("Marcar como perdida");
    expect(html).not.toContain("Marcar como encontrada");
    // Still has the everyday actions.
    for (const label of ["Compartir", "Editar datos", "Más"]) {
      expect(html).toContain(`>${label}`);
    }
  });

  it("deceased pet: collapses to [Compartir][Más] only (ADR-15/REQ-9.3)", () => {
    const html = renderToStaticMarkup(
      <PetActionRow petPublicToken="abc" isOwner isDeceased={true} petStatus="deceased" />,
    );
    expect(html).toContain(">Compartir");
    expect(html).toContain(">Más");
    expect(html).not.toContain("Editar datos");
    expect(html).not.toContain("Marcar como");
    const anchors = html.match(/<a [^>]*>/g) ?? [];
    expect(anchors.length).toBe(2);
  });

  it("org viewer (isOwner=false): only Compartir renders, no owner-only affordances", () => {
    const html = renderToStaticMarkup(
      <PetActionRow petPublicToken="abc" isOwner={false} isDeceased={false} petStatus="active" />,
    );
    expect(html).toContain(">Compartir");
    expect(html).not.toContain("Editar datos");
    expect(html).not.toContain("Marcar como");
    expect(html).not.toContain(">Más");
    const anchors = html.match(/<a [^>]*>/g) ?? [];
    expect(anchors.length).toBe(1);
  });
});
