// @vitest-environment jsdom
// The empty-avatar "add a photo" shortcut, and the three ways it must stay shut.
//
// PO ask 2026-08-01: tapping a pet's avatar when it has no picture should start
// adding one, reusing what already exists. It does — as a LINK to the edit sheet
// (`?sheet=editar-mascota`), so the file input, its validation, the server
// action and the storage write all stay where they are. There is no second
// upload path to keep correct.
//
// WHAT THESE TESTS ACTUALLY GUARD is the opposite direction. LnPetPhoto renders
// on the public credential and inside read-only registry rows. An affordance
// that leaks into those offers an action the viewer cannot perform — and on the
// public page it would suggest a stranger can edit someone's animal. So the
// interesting assertions here are the absences: no href prop, a photo already
// present, and (the one a snapshot would never catch) a row that is ITSELF a
// link, where a nested anchor is invalid HTML and the inner target is
// unreachable by keyboard.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LnPetPhoto, LnRegRow } from "@/components/ui/RegRow";

const HREF = "/mis-mascotas/DIM-TEST-0001?sheet=editar-mascota";

describe("LnPetPhoto — add-photo shortcut", () => {
  it("offers the link when there is no photo and a caller opted in", () => {
    render(<LnPetPhoto alt="Pampa" addPhotoHref={HREF} addPhotoLabel="Pampa" />);
    const link = screen.getByRole("link", { name: "Agregar foto de Pampa" });
    expect(link.getAttribute("href")).toBe(HREF);
  });

  it("names the animal in the accessible label", () => {
    // "Agregar foto" alone is ambiguous the moment two pets are on screen —
    // a screen-reader user hears the same control twice with no way to tell
    // which animal it belongs to.
    render(<LnPetPhoto alt="Michi" addPhotoHref={HREF} addPhotoLabel="Michi" />);
    expect(screen.queryByRole("link", { name: "Agregar foto de Michi" })).not.toBeNull();
  });

  it("stays a plain placeholder when the caller did NOT opt in", () => {
    // The default. Public credential, registry rows, any read-only viewer.
    render(<LnPetPhoto alt="Pampa" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("foto")).toBeTruthy();
  });

  it("stays a plain photo when one already exists, even with the href passed", () => {
    // Replacing a photo is an EDIT — it belongs in the form where the old image
    // is visible beside the new one. This shortcut is only the empty state, and
    // a caller that passes the href unconditionally must not turn every avatar
    // into a link.
    render(<LnPetPhoto src="/pampa.jpg" alt="Pampa" addPhotoHref={HREF} addPhotoLabel="Pampa" />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("LnRegRow — the row is the link, so the avatar must not be", () => {
  it("renders no nested link inside a linked row", () => {
    // LnRegRow wraps the whole row in an anchor. An anchor inside an anchor is
    // invalid HTML: browsers unnest it, the inner target becomes unreachable by
    // keyboard, and which one fires on tap is anyone's guess. LnRegRow
    // therefore never forwards the shortcut — this pins that it cannot start.
    render(<LnRegRow name="Pampa" href="/mis-mascotas/DIM-TEST-0001" />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/mis-mascotas/DIM-TEST-0001");
  });
});
