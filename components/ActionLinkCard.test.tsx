// Smoke tests for <ActionLinkCard> — same render-via-server pattern as
// Checkbox.test.tsx and Field.test.tsx.

import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ActionLinkCard } from "./ActionLinkCard";

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

describe("<ActionLinkCard>", () => {
  it("renders title and description", () => {
    const html = render(
      <ActionLinkCard
        href="/mis-mascotas/reclamar"
        icon="qr"
        title="Reclamar mascota existente"
        description="Tu mascota ya tiene chapita"
      />,
    );
    expect(html).toContain("Reclamar mascota existente");
    expect(html).toContain("Tu mascota ya tiene chapita");
  });

  it("renders the href as an anchor", () => {
    const html = render(
      <ActionLinkCard
        href="/mis-mascotas/postulaciones"
        icon="corazon"
        title="Mis postulaciones"
        description="Adopciones a las que te postulaste"
      />,
    );
    expect(html).toContain('href="/mis-mascotas/postulaciones"');
  });

  it("renders badge when badge > 0", () => {
    const html = render(
      <ActionLinkCard
        href="/mis-mascotas/postulaciones"
        icon="corazon"
        title="Mis postulaciones"
        description="Adopciones a las que te postulaste"
        badge={3}
      />,
    );
    expect(html).toContain(">3<");
  });

  it("does not render badge when badge is 0", () => {
    const html = render(
      <ActionLinkCard
        href="/mis-mascotas/postulaciones"
        icon="corazon"
        title="Mis postulaciones"
        description="Adopciones a las que te postulaste"
        badge={0}
      />,
    );
    // Badge span should not appear — 0 is falsy in the badge > 0 check
    expect(html).not.toContain("min-w-[1.25rem]");
  });

  it("renders nothing when hideWhenZero is true and badge is 0", () => {
    const html = render(
      <ActionLinkCard
        href="/cuenta/memberships"
        icon="edificio"
        title="Transferencias pendientes"
        description="Mascotas que alguien quiere transferirte"
        badge={0}
        hideWhenZero
      />,
    );
    expect(html).toBe("");
  });

  it("renders nothing when hideWhenZero is true and badge is null", () => {
    const html = render(
      <ActionLinkCard
        href="/cuenta/memberships"
        icon="edificio"
        title="Transferencias pendientes"
        description="Mascotas que alguien quiere transferirte"
        badge={null}
        hideWhenZero
      />,
    );
    expect(html).toBe("");
  });

  it("renders when hideWhenZero is true and badge > 0", () => {
    const html = render(
      <ActionLinkCard
        href="/cuenta/memberships"
        icon="edificio"
        title="Transferencias pendientes"
        description="Mascotas que alguien quiere transferirte"
        badge={2}
        hideWhenZero
      />,
    );
    expect(html).toContain("Transferencias pendientes");
    expect(html).toContain(">2<");
  });

  it("renders normally without badge or hideWhenZero", () => {
    const html = render(
      <ActionLinkCard
        href="/mis-mascotas/reclamar"
        icon="qr"
        title="Reclamar mascota existente"
        description="Ya registrada"
      />,
    );
    expect(html).toContain("Reclamar mascota existente");
    expect(html).not.toContain("min-w-[1.25rem]");
  });
});

describe("<ActionLinkCard> — the C.2 orphaned-route shape", () => {
  // The transfers card on /mis-mascotas used to pass `hideWhenZero` as a bare
  // flag against the INCOMING count. A user who had SENT a transfer and had no
  // incoming ones lost the only link to /transferencias — while that page has
  // carried an "Enviadas" section since UX 3.1, so a live pending proposal sat
  // there with nothing pointing at it.
  //
  // The fix makes visibility a decision the CALLER computes over both
  // directions, so these pin the two states that used to collapse into one.
  it("stays visible with no badge when hideWhenZero is false (outgoing-only)", () => {
    const html = render(
      <ActionLinkCard
        href="/transferencias"
        icon="transferencia"
        title="Transferencias pendientes"
        description="Mascotas que alguien quiere transferirte, y las que enviaste"
        badge={null}
        hideWhenZero={false}
      />,
    );
    // The LINK is what matters — without it the route is unreachable.
    expect(html).toContain('href="/transferencias"');
    // No badge: an outgoing proposal waits on someone else, so it earns the
    // link but must not read as a call to action.
    expect(html).not.toContain("aria-label");
  });

  it("still hides when the caller says both directions are empty", () => {
    const html = render(
      <ActionLinkCard
        href="/transferencias"
        icon="transferencia"
        title="Transferencias pendientes"
        description="Mascotas que alguien quiere transferirte, y las que enviaste"
        badge={null}
        hideWhenZero={true}
      />,
    );
    expect(html).toBe("");
  });
});
