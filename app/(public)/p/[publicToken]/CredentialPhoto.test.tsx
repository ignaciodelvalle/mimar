// @vitest-environment jsdom
//
// CredentialPhoto — the photo on the page every QR scan lands on.
//
// The page already handled "no photo row" with a render-time conditional. What
// it could not see was a photo row whose storage object is GONE: the URL builds
// fine, the request 404s, and next/image renders a broken-image glyph on the
// most public surface in the product. These tests pin the runtime failure path,
// which is the half a render-time conditional structurally cannot cover.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CredentialPhoto } from "./CredentialPhoto";

afterEach(cleanup);

const PHOTO = "https://storage.example.test/pets/pampa.jpg";

describe("CredentialPhoto", () => {
  it("renders the photo when the URL loads", () => {
    render(<CredentialPhoto src={PHOTO} petName="Pampa" />);
    expect(screen.getByRole("img", { name: "Pampa" })).toBeInTheDocument();
  });

  it("falls back to the initial-letter card when the photo FAILS TO LOAD", () => {
    render(<CredentialPhoto src={PHOTO} petName="Pampa" />);

    fireEvent.error(screen.getByRole("img", { name: "Pampa" }));

    // The broken image is gone — not merely hidden behind it.
    expect(screen.queryByRole("img", { name: "Pampa" })).not.toBeInTheDocument();
    expect(screen.getByText("P")).toBeInTheDocument();
  });

  it("renders the same fallback when there is no photo at all", () => {
    render(<CredentialPhoto src={null} petName="Rocco" />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("R")).toBeInTheDocument();
  });

  it("uppercases the initial regardless of how the name was typed", () => {
    render(<CredentialPhoto src={null} petName="ñandú" />);
    expect(screen.getByText("Ñ")).toBeInTheDocument();
  });
});
