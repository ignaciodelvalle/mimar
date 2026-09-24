// @vitest-environment jsdom
//
// DegradedCredentialCard — the render an anonymous finder gets when the QR
// page's DB reads fail or exceed their budget. Locks the honesty contract:
// explicit degraded copy + visually-distinct stamp (never fake-empty data),
// and the lost-mode CTAs staying reachable when the pet row resolved.

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DegradedCredentialCard } from "./DegradedCredentialCard";

const TOKEN = "dim-pamp-0001";

afterEach(cleanup);

describe("DegradedCredentialCard", () => {
  it("renders the honest degraded message, stamp, and token — never a crash page", () => {
    render(<DegradedCredentialCard publicToken={TOKEN} />);

    expect(
      screen.getByText("No pudimos cargar todos los datos. Reintentá en unos segundos."),
    ).toBeInTheDocument();
    expect(screen.getByText("DATOS INCOMPLETOS")).toBeInTheDocument();
    expect(screen.getByText(/DIM-PAMP-0001/)).toBeInTheDocument();
    // Retry goes back to the same credential URL.
    expect(screen.getByRole("link", { name: "Reintentar" })).toHaveAttribute("href", `/p/${TOKEN}`);
  });

  it("falls back to a generic h1 (page orientation) and shows no lost CTAs when the pet row never resolved", () => {
    render(<DegradedCredentialCard publicToken={TOKEN} />);

    expect(screen.getByRole("heading", { name: "Credencial" })).toBeInTheDocument();
    expect(document.querySelector('[data-section="degraded-lost-ctas"]')).toBeNull();
  });

  it("keeps both lost-mode CTAs when the pet is lost and the finder form is enabled", () => {
    render(
      <DegradedCredentialCard
        publicToken={TOKEN}
        petName="Pampa"
        petSex="female"
        isLost
        allowFinderForm
      />,
    );

    expect(screen.getByRole("heading", { name: "Pampa" })).toBeInTheDocument();
    const links = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(links).toContain(`/p/${TOKEN}/encontre`);
    expect(links).toContain(`/p/${TOKEN}/sighting`);
  });

  it("omits the finder-form CTA when the owner disabled it, keeping the sighting CTA", () => {
    render(
      <DegradedCredentialCard
        publicToken={TOKEN}
        petName="Pampa"
        petSex="female"
        isLost
        allowFinderForm={false}
      />,
    );

    const links = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(links).not.toContain(`/p/${TOKEN}/encontre`);
    expect(links).toContain(`/p/${TOKEN}/sighting`);
  });

  it("shows no lost CTAs for a non-lost pet even when the name is known", () => {
    render(<DegradedCredentialCard publicToken={TOKEN} petName="Bobbie" isLost={false} />);

    expect(document.querySelector('[data-section="degraded-lost-ctas"]')).toBeNull();
  });
});
