// Tests for <PetActionPanel> — the grouped panel under the primary row
// (owner-pet-actions, PO 2026-10-01). What used to hide behind "⋯ Más" is shown
// inline, grouped LA MASCOTA / SALUD / VIAJES / CUSTODIA, with "Reportar
// fallecimiento" apart at the bottom; what does not apply is grey, with the
// reason. Pattern: react-dom/server renderToStaticMarkup (repo convention).

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  PET_ACTION_INERT_CAPTIONS,
  type PetActionContext,
  derivePetActions,
} from "@dim/contract/reference";

import { PetActionPanel } from "./PetActionPanel";
import { type WebPetActionGroup, resolveWebPetActions } from "./pet-action-web";

const TITULAR: PetActionContext = {
  viewerRole: "owner",
  isTitular: true,
  petStatus: "active",
  species: "dog",
  pppDoor: false,
};

function groups(ctx: PetActionContext): WebPetActionGroup[] {
  return resolveWebPetActions(derivePetActions(ctx), {
    petPublicToken: "abc",
    petStatus: ctx.petStatus ?? "active",
  }).groups;
}

function render(ctx: PetActionContext): string {
  return renderToStaticMarkup(<PetActionPanel groups={groups(ctx)} />);
}

/** The markup of the one row whose label is `label`, from its tag to the next row. */
function rowOf(html: string, label: string): string {
  const at = html.indexOf(`>${label}<`);
  expect(at, `row "${label}" is on the panel`).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<li", at);
  const end = html.indexOf("</li>", at);
  return html.slice(start, end);
}

describe("<PetActionPanel> — the groups, in the panel's order", () => {
  it("titular of a dog: four headed groups, then the closing act apart", () => {
    const html = render(TITULAR);
    const headings = ["La mascota", "Salud", "Viajes", "Custodia"];
    const positions = headings.map((h) => html.indexOf(`>${h}</h2>`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // The closing act has no heading and comes after everything else.
    expect(html.indexOf(">Reportar fallecimiento<")).toBeGreaterThan(positions[3] as number);
    expect(html.match(/<h2/g) ?? []).toHaveLength(4);
  });

  it("offers every row of the titular's panel live, as a link", () => {
    const html = render(TITULAR);
    const rows = groups(TITULAR).flatMap((g) => g.actions);
    expect(rows.length).toBeGreaterThan(10);
    expect(html.match(/<a [^>]*>/g) ?? []).toHaveLength(rows.length);
    expect(html).not.toContain('aria-disabled="true"');
  });

  it("keeps the attestation off the panel — it stays on the compliance card", () => {
    const html = render({ ...TITULAR, pppDoor: true });
    expect(html).not.toMatch(/atestaci/i);
  });
});

describe("<PetActionPanel> — what does not apply is grey, with the reason", () => {
  it("a co-owner reads the titular's rows, unlinked, each saying 'Solo el titular'", () => {
    const html = render({ ...TITULAR, viewerRole: "co_owner", isTitular: false });
    for (const label of [
      "Transferir la titularidad",
      "Cuidador temporal",
      "Contactos de emergencia",
    ]) {
      const row = rowOf(html, label);
      expect(row).not.toContain("<a ");
      expect(row).toContain('aria-disabled="true"');
      expect(row).toContain(PET_ACTION_INERT_CAPTIONS.titular_only);
    }
    // ...and keeps the rows that ARE theirs.
    expect(rowOf(html, "Editar datos")).toContain("<a ");
  });

  it("a caretaker sees Editar datos grey, and Foto as a door of its own, as on the app", () => {
    const html = render({ ...TITULAR, viewerRole: "caretaker", isTitular: false });
    expect(rowOf(html, "Editar datos")).toContain(PET_ACTION_INERT_CAPTIONS.caretaker);
    const photo = rowOf(html, "Foto");
    expect(photo).toContain("<a ");
    expect(photo).toContain("sheet=foto");
    expect(photo).not.toContain('aria-disabled="true"');
    // A caretaker still reaches what the role exists for.
    expect(rowOf(html, "Reportar fallecimiento")).toContain("<a ");
  });

  it("captions the death row with what it closes, even while live", () => {
    expect(rowOf(render(TITULAR), "Reportar fallecimiento")).toContain(
      "Cierra el registro del animal",
    );
  });
});

describe("<PetActionPanel> — rows that are not this viewer's world are absent", () => {
  it("a deceased animal keeps Editar datos, Foto and Contactos, and nothing else here", () => {
    const html = render({ ...TITULAR, petStatus: "deceased" });
    for (const label of ["Editar datos", "Foto", "Contactos de emergencia"]) {
      expect(html).toContain(`>${label}<`);
    }
    for (const label of [
      "Viaje y movilidad",
      "Transferir la titularidad",
      "Reportar fallecimiento",
    ]) {
      expect(html).not.toContain(`>${label}<`);
    }
    expect(html).not.toContain(">Viajes</h2>");
  });

  it("an organization member gets no panel at all", () => {
    expect(render({ ...TITULAR, viewerRole: "org_member", isTitular: false })).toBe("");
  });
});
