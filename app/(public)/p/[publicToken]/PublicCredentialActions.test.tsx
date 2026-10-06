// @vitest-environment jsdom
//
// Finder verbs under the public card. The paper never carries these.

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DISPUTE_TIP_NOTICE } from "@/lib/ui/dispute-copy";

import {
  NO_CHANNELS_WARNING,
  PHONE_PRIVACY_NOTE,
  PublicCredentialActions,
  type PublicCredentialActionsProps,
} from "./PublicCredentialActions";

vi.mock("./FoundPetForm", () => ({
  FoundPetForm: () => <div data-testid="found-form" />,
}));
vi.mock("./DisputeTipForm", () => ({
  DisputeTipForm: () => <div data-testid="dispute-form" />,
}));

afterEach(cleanup);

describe("PublicCredentialActions — found", () => {
  it("genders the tile and keeps the form outside the summary", () => {
    render(<PublicCredentialActions mode="found" publicToken="DIM-TEST-0001" petSex="female" />);

    expect(screen.getByText("¿La encontraste?")).toBeInTheDocument();
    expect(screen.getByTestId("found-form")).toBeInTheDocument();
  });
});

describe("PublicCredentialActions — lost row", () => {
  it("Lo tengo is the heavier primary; Lo vi and Llamar stay outline", () => {
    render(
      <PublicCredentialActions
        mode="lost"
        petSex="male"
        finderFormHref="/p/DIM-TEST-0001/encontre"
        sightingFormHref="/p/DIM-TEST-0001/sighting"
        ownerPhoneE164="+5491155551234"
        ownerEmail={null}
        ownerFirstName="Martín"
        caretakerContact={null}
      />,
    );

    const have = screen.getByRole("link", { name: /tengo conmigo/i });
    expect(have).toHaveAttribute("href", "/p/DIM-TEST-0001/encontre");
    expect(have.className).toContain("ln-act--primary");

    const saw = screen.getByRole("link", { name: /vi cerca/i });
    expect(saw).toHaveAttribute("href", "/p/DIM-TEST-0001/sighting");
    expect(saw.className).not.toContain("ln-act--primary");

    const call = screen.getByRole("link", { name: /^Llamar$/ });
    expect(call).toHaveAttribute("href", expect.stringContaining("tel:"));
    expect(call.textContent).not.toMatch(/Martín/);
    expect(call.className).not.toContain("ln-act--primary");
  });

  it("email is a line, not a tile; Llamar is absent when the phone is hidden", () => {
    render(
      <PublicCredentialActions
        mode="lost"
        petSex="female"
        finderFormHref="/p/DIM-TEST-0001/encontre"
        sightingFormHref="/p/DIM-TEST-0001/sighting"
        ownerPhoneE164={null}
        ownerEmail="ana@example.test"
        ownerFirstName="Ana"
        caretakerContact={null}
      />,
    );

    expect(screen.queryByRole("link", { name: /^Llamar$/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Escribirle a Ana/ })).toHaveAttribute(
      "href",
      "mailto:ana@example.test",
    );
    // Phone hidden + aviso paths → the privacy note explains the missing Llamar.
    expect(screen.getByText(PHONE_PRIVACY_NOTE)).toBeInTheDocument();
  });

  it("caretaker phone is a line under the row, never a second primary tile", () => {
    render(
      <PublicCredentialActions
        mode="lost"
        petSex="female"
        finderFormHref={null}
        sightingFormHref="/p/DIM-TEST-0001/sighting"
        ownerPhoneE164="+541155550000"
        ownerEmail={null}
        ownerFirstName={null}
        caretakerContact={{ firstName: "Ana", phoneE164: "+541155550001" }}
      />,
    );

    const caretaker = screen.getByRole("link", { name: /Llamar a Ana/ });
    expect(caretaker).toHaveAttribute("href", "tel:+541155550001");
    expect(caretaker.className).not.toContain("ln-act--primary");
    expect(caretaker.closest("[data-section='lost-cta-row']")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Honest contact lines (Cowork I1 / Cursor IDEA, R3.4.12). These lived in
// PublicLostSections on main; the redesign moved the verbs under the card and
// dropped the lines with their tests. Restored 2026-10-06 — same behaviour,
// new home.
// ---------------------------------------------------------------------------

type LostProps = Extract<PublicCredentialActionsProps, { mode: "lost" }>;

function renderLost(overrides: Partial<LostProps>) {
  return render(
    <PublicCredentialActions
      mode="lost"
      petSex="female"
      finderFormHref={null}
      sightingFormHref={null}
      ownerPhoneE164={null}
      ownerEmail={null}
      ownerFirstName={null}
      caretakerContact={null}
      {...overrides}
    />,
  );
}

describe("PublicCredentialActions — phone-privacy note", () => {
  it("renders when the phone is hidden and a finder form is available", () => {
    renderLost({ finderFormHref: "/p/DIM-TEST-0001/encontre" });
    expect(screen.getByText(PHONE_PRIVACY_NOTE)).toBeInTheDocument();
  });

  it("renders when the phone is hidden and only a sighting form is available", () => {
    renderLost({ sightingFormHref: "/p/DIM-TEST-0001/sighting" });
    expect(screen.getByText(PHONE_PRIVACY_NOTE)).toBeInTheDocument();
  });

  it("does NOT render next to a call CTA (phone disclosed)", () => {
    renderLost({
      ownerPhoneE164: "+5491155551234",
      finderFormHref: "/p/DIM-TEST-0001/encontre",
    });
    expect(screen.queryByText(PHONE_PRIVACY_NOTE)).toBeNull();
    expect(screen.getByRole("link", { name: /^Llamar$/ })).toHaveAttribute(
      "href",
      expect.stringContaining("tel:"),
    );
  });

  it("does NOT render when there is no aviso path — the no-channels warning owns that state", () => {
    renderLost({});
    expect(screen.queryByText(PHONE_PRIVACY_NOTE)).toBeNull();
    expect(screen.getByText(NO_CHANNELS_WARNING)).toBeInTheDocument();
  });

  it("is not suppressed by a caretaker phone — the titular's phone is still hidden", () => {
    renderLost({
      sightingFormHref: "/p/DIM-TEST-0001/sighting",
      caretakerContact: { firstName: "Ana", phoneE164: "+541155550001" },
    });
    expect(screen.getByText(PHONE_PRIVACY_NOTE)).toBeInTheDocument();
  });
});

describe("PublicCredentialActions — no-channels warning", () => {
  it("renders only when NO channel exists (no phone, email, finder or sighting form)", () => {
    renderLost({});
    expect(screen.getByText(NO_CHANNELS_WARNING)).toBeInTheDocument();
  });

  it("is absent when a phone is disclosed", () => {
    renderLost({ ownerPhoneE164: "+5491155551234" });
    expect(screen.queryByText(NO_CHANNELS_WARNING)).toBeNull();
  });

  it("is absent when only a sighting form exists", () => {
    renderLost({ sightingFormHref: "/p/DIM-TEST-0001/sighting" });
    expect(screen.queryByText(NO_CHANNELS_WARNING)).toBeNull();
  });

  // Email-only edge state (Cursor/Cowork staging triage 2026-07-17): a working
  // mailto IS a channel, so "no channels" would lie; there is no aviso path to
  // point at, so the privacy line has nothing to say either.
  it("email-only: ONLY the email link — no call CTA, no privacy line, no warning", () => {
    renderLost({ ownerEmail: "lucia@example.test" });
    expect(screen.getByRole("link", { name: /Escribir por email/ })).toHaveAttribute(
      "href",
      "mailto:lucia@example.test",
    );
    expect(screen.queryByRole("link", { name: /^Llamar$/ })).toBeNull();
    expect(screen.queryByText(PHONE_PRIVACY_NOTE)).toBeNull();
    expect(screen.queryByText(NO_CHANNELS_WARNING)).toBeNull();
  });
});

describe("PublicCredentialActions — dispute", () => {
  it("offers only the authority tip, no relay routes", () => {
    const { container } = render(
      <PublicCredentialActions mode="dispute" publicToken="DIM-TEST-0001" />,
    );

    expect(container.querySelector('[data-section="found-form-disputed"]')).not.toBeNull();
    expect(screen.getByText("Tengo información")).toBeInTheDocument();
    expect(screen.getByTestId("dispute-form")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /encontre|sighting|tengo|vi cerca/i })).toBeNull();
    // A disputed pet never shows the misleading "no channels" line.
    expect(screen.queryByText(NO_CHANNELS_WARNING)).toBeNull();
  });

  // D2 (PO 2026-07-30): the finder must know, BEFORE opening anything, that
  // the message goes to the authority and not to the registered owner.
  it("states the routing visibly, outside the closed details", () => {
    const { container } = render(
      <PublicCredentialActions mode="dispute" publicToken="DIM-TEST-0001" />,
    );
    const notice = container.querySelector('[data-section="lost-custody-dispute-notice"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain(DISPUTE_TIP_NOTICE);
    expect(notice?.closest("details")).toBeNull();
    expect(notice).toBeVisible();
  });
});
