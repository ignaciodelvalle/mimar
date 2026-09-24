// @vitest-environment jsdom
//
// Interaction test for bug #66: after a step-1 "Guardar y continuar" save, the
// step-2 "Publicar adopción" button was permanently disabled. The old
// implementation wrapped the save action in useTransition; the action's
// revalidatePath rides Next 15.5.x's dropped-refresh transition machinery, so
// isPending never cleared and the shared `disabled={pending || !canPublish}`
// gate stuck the publish button off forever. The fix drives `pending` off a
// plain useState boolean that clears the moment the action's fetch resolves.
//
// Pattern follows NumericWindowRuleForm.interaction.test.tsx (RTL + jsdom, real
// hooks, waitFor for the async action → state chain).

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const updateContentMock = vi.fn();
const setStatusMock = vi.fn();

vi.mock("@/src/modules/adoption/actions", () => ({
  updateAdoptionListingContentAction: (...args: unknown[]) => updateContentMock(...args),
  setAdoptionListingStatusAction: (...args: unknown[]) => setStatusMock(...args),
}));

const navigateMock = vi.fn();
vi.mock("@/lib/ui/full-page-action-nav", () => ({
  navigateAfterActionSuccess: (url: string) => navigateMock(url),
}));

import { AdoptionListingForm } from "./AdoptionListingForm";

const BASE_INITIAL = {
  isPublished: false,
  isPaused: false,
  story: null,
  requirements: null,
  ageBucket: null,
  sizeEstimate: null,
  energyLevel: null,
  goodWithKids: null,
  goodWithDogs: null,
  goodWithCats: null,
  needsYard: null,
  feeArs: null,
};

function renderForm(overrides?: { canPublish?: boolean }) {
  return render(
    <AdoptionListingForm
      orgToken="ORG-TEST-0001"
      petPublicToken="DIM-TEST-0001"
      initial={BASE_INITIAL}
      canPublish={overrides?.canPublish ?? true}
      petSex="male"
    />,
  );
}

beforeEach(() => {
  updateContentMock.mockReset();
  setStatusMock.mockReset();
  navigateMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("<AdoptionListingForm> — publish enablement after save (bug #66)", () => {
  it("leaves the 'Publicar adopción' button enabled after a successful step-1 save", async () => {
    updateContentMock.mockResolvedValue({ ok: true });

    renderForm({ canPublish: true });

    // Step 2 is aria-hidden until the save advances the wizard, so the publish
    // button only enters the accessibility tree after "Datos guardados.".
    fireEvent.click(screen.getByRole("button", { name: "Guardar y continuar" }));

    await waitFor(() => {
      expect(screen.getAllByText("Datos guardados.").length).toBeGreaterThan(0);
    });

    // The regression: pending must clear so the publish button is usable in the
    // same session. With the old useTransition it would stay disabled forever.
    expect(screen.getByRole("button", { name: "Publicar adopción" })).not.toBeDisabled();
    expect(updateContentMock).toHaveBeenCalledTimes(1);
  });

  it("re-enables the save button and surfaces the error when the save fails", async () => {
    updateContentMock.mockResolvedValue({ error: "No se pudo guardar." });

    renderForm({ canPublish: true });

    const saveBtn = screen.getByRole("button", { name: "Guardar y continuar" });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(screen.getAllByText("No se pudo guardar.").length).toBeGreaterThan(0);
    });

    // pending cleared on the error path too — the operator can retry.
    expect(saveBtn).not.toBeDisabled();
  });

  it("keeps 'Publicar adopción' disabled when canPublish is false, even after save", async () => {
    updateContentMock.mockResolvedValue({ ok: true });

    renderForm({ canPublish: false });

    fireEvent.click(screen.getByRole("button", { name: "Guardar y continuar" }));

    await waitFor(() => {
      expect(screen.getAllByText("Datos guardados.").length).toBeGreaterThan(0);
    });

    // Blockers (lost/deceased/ineligible/etc.) still gate publish independently.
    expect(screen.getByRole("button", { name: "Publicar adopción" })).toBeDisabled();
  });

  it("publishes via setAdoptionListingStatusAction and triggers a full reload", async () => {
    updateContentMock.mockResolvedValue({ ok: true });
    setStatusMock.mockResolvedValue({ ok: true });

    renderForm({ canPublish: true });

    // Advance to step 2 first (publish lives there and is aria-hidden on step 1).
    fireEvent.click(screen.getByRole("button", { name: "Guardar y continuar" }));
    await waitFor(() => {
      expect(screen.getAllByText("Datos guardados.").length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getByRole("button", { name: "Publicar adopción" }));

    await waitFor(() => {
      // orgToken is part of the contract now, and asserting it here is the
      // point: without it the action falls back to the session-default org and
      // a multi-org member publishes against the wrong one (21-authz-scoping
      // -audit #10). The pet token alone cannot disambiguate.
      expect(setStatusMock).toHaveBeenCalledWith({
        orgToken: "ORG-TEST-0001",
        petPublicToken: "DIM-TEST-0001",
        action: "publish",
      });
    });
    expect(navigateMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Step contract (staging validation 2026-08-01, bug 3). Reported across three
// wizards: summary CTAs clickable before the final step (silently doing
// nothing), and choices lost on back-navigation.
//
// Neither reproduced here, but nothing asserted either — the tests above only
// ever move FORWARD, once. Publishing an adoption listing from step 1 was held
// shut by a single a11y attribute (`inert`, added by c5994e62 for WCAG 4.1.2),
// with no guard in runStatus and no test that would notice its removal.
//
// jsdom does not implement `inert`, so `{ hidden: true }` clicks straight
// through it — which is what makes the handler guard observable.
// ---------------------------------------------------------------------------

describe("<AdoptionListingForm> — publishing is gated on the step, not only on `inert`", () => {
  it("THE GUARD: clicking 'Publicar adopción' from step 1 publishes nothing", () => {
    setStatusMock.mockResolvedValue({ ok: true });
    renderForm({ canPublish: true });

    // canPublish is true, so the button carries no disabled attribute even on
    // step 1 — the step check inside runStatus is the only thing left.
    const publish = screen.getByRole("button", { name: "Publicar adopción", hidden: true });
    expect(publish).not.toBeDisabled();
    fireEvent.click(publish);

    expect(setStatusMock).not.toHaveBeenCalled();
  });

  it("step-1 content survives advancing to step 2 and coming back", async () => {
    updateContentMock.mockResolvedValue({ ok: true });
    renderForm({ canPublish: true });

    const story = screen.getByLabelText(/Historia/i);
    fireEvent.change(story, { target: { value: "Rocío llegó en junio." } });

    fireEvent.click(screen.getByRole("button", { name: "Guardar y continuar" }));
    await waitFor(() => {
      expect(screen.getAllByText("Datos guardados.").length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getByRole("button", { name: "Paso anterior" }));
    expect(screen.getByLabelText(/Historia/i)).toHaveValue("Rocío llegó en junio.");
  });
});
