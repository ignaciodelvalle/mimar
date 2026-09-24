// @vitest-environment jsdom
//
// Autoconfirm contract for the notification quick-reply island's "Confirmar"
// path (capture-console surface #4): VaccinationForm / CheckinForm submit
// themselves ONCE on mount when `autoConfirm` is true AND their own native
// `required` validation passes (form.checkValidity()) — reusing the form's
// existing validation instead of the island duplicating it. An invalid
// prefill must land in edit mode (no submit call), never a silent failure.

import "@testing-library/jest-dom/vitest";

import { cleanup, render } from "@testing-library/react";
import React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
});

vi.mock("@/lib/ui/use-idempotency-key", () => ({
  useIdempotencyKey: () => ({ key: "test-idempotency-key" }),
}));
vi.mock("@/lib/ui/use-form-error-focus", () => ({
  useFormErrorFocus: () => ({ current: null }),
}));
vi.mock("@/lib/ui/use-action-redirect", () => ({
  useActionRedirect: () => {},
}));
vi.mock("@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/AttachmentField", () => ({
  AttachmentField: () => React.createElement("div", { "data-testid": "attachment-field" }),
}));
vi.mock("@/components/Icon", () => ({
  Icon: () => React.createElement("span", { "data-testid": "icon" }),
}));
vi.mock("@/components/LocationFields", () => ({
  LocationFields: () => React.createElement("div", { "data-testid": "location-fields" }),
}));

import { CheckinForm } from "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/checkin/CheckinForm";
import { VaccinationForm } from "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/vacuna/VaccinationForm";

afterEach(() => cleanup());

describe("VaccinationForm — notification quick-reply autoconfirm", () => {
  it("submits once on mount when autoConfirm=true and the reminder prefilled a valid vaccine name + date", async () => {
    const action = vi.fn(async (_prev: { error: string | null }, _formData: FormData) => ({
      error: null,
    }));
    render(
      React.createElement(VaccinationForm, {
        action,
        species: "dog",
        initialVaccineName: "Antirrábica",
        sourceReminderId: "reminder-1",
        autoConfirm: true,
      }),
    );

    // requestSubmit() dispatches asynchronously via React's action queue.
    await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const formData = action.mock.calls[0][1];
    expect(formData.get("vaccineName")).toBe("Antirrábica");
    expect(String(formData.get("occurredAt"))).not.toBe("");
    expect(formData.get("sourceReminderId")).toBe("reminder-1");
  });

  it("does NOT submit when autoConfirm=true but the vaccine name never got prefilled (invalid — lands in edit mode)", async () => {
    const action = vi.fn(async () => ({ error: null }));
    render(
      React.createElement(VaccinationForm, {
        action,
        species: "dog",
        // No initialVaccineName, no reminder — the required "Vacuna" field
        // is empty, so native checkValidity() must block the auto-submit.
        autoConfirm: true,
      }),
    );

    // Give the mount effect a tick to (not) fire.
    await new Promise((r) => setTimeout(r, 0));
    expect(action).not.toHaveBeenCalled();
  });

  it("does not auto-submit at all when autoConfirm is false/unset (normal manual flow)", async () => {
    const action = vi.fn(async () => ({ error: null }));
    render(
      React.createElement(VaccinationForm, {
        action,
        species: "dog",
        initialVaccineName: "Antirrábica",
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(action).not.toHaveBeenCalled();
  });
});

describe("CheckinForm — notification quick-reply autoconfirm", () => {
  it("submits once on mount when autoConfirm=true (no required fields — always valid)", async () => {
    const action = vi.fn(async (_prev: { error: string | null }, _formData: FormData) => ({
      error: null,
    }));
    render(
      React.createElement(CheckinForm, {
        action,
        defaults: { notes: "Todo bien" },
        autoConfirm: true,
      }),
    );

    await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const formData = action.mock.calls[0][1];
    expect(formData.get("notes")).toBe("Todo bien");
  });

  it("does not auto-submit when autoConfirm is false/unset", async () => {
    const action = vi.fn(async () => ({ error: null }));
    render(React.createElement(CheckinForm, { action, defaults: { notes: null } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(action).not.toHaveBeenCalled();
  });
});
