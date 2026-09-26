// @vitest-environment jsdom
//
// The ENO diagnosis step (PO S2): a rejected submit must not swap the picked
// disease back to the placeholder (React 19's post-action reset — see
// __tests__/react19-form-reset-contract.test.tsx), and the lab fields appear
// only for a lab-confirmed diagnosis.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/LocationFields", () => ({
  LocationFields: () => React.createElement("div", { "data-testid": "location-fields" }),
}));

import { DiseaseDiagnosisForm } from "./DiseaseDiagnosisForm";

afterEach(cleanup);

describe("<DiseaseDiagnosisForm>", () => {
  it("offers only the species' notifiable diseases and names the legal window", () => {
    const { container, getByText } = render(
      <DiseaseDiagnosisForm action={vi.fn()} species="dog" />,
    );
    const select = container.querySelector('select[name="diseaseCode"]') as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toContain("leptospirosis");
    expect(values).not.toContain("parvovirus");
    fireEvent.change(select, { target: { value: "leptospirosis" } });
    expect(getByText(/plazo de 24 h desde la fecha del diagnóstico/)).toBeInTheDocument();
  });

  it("asks for the lab only when the diagnosis is lab-confirmed", () => {
    const { container, getByLabelText } = render(
      <DiseaseDiagnosisForm action={vi.fn()} species="dog" />,
    );
    expect(container.querySelector('input[name="labName"]')).toBeNull();
    fireEvent.click(getByLabelText("Confirmado por laboratorio"));
    expect(container.querySelector('input[name="labName"]')).not.toBeNull();
  });

  it("keeps the picked disease after a rejected submit", async () => {
    const action = vi.fn(async () => ({ error: "No se pudo registrar el diagnóstico." }));
    const { container } = render(<DiseaseDiagnosisForm action={action} species="dog" />);
    const select = container.querySelector('select[name="diseaseCode"]') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "canine_brucellosis" } });
    (container.querySelector("form") as HTMLFormElement).requestSubmit();
    await waitFor(() => expect(action).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        (container.querySelector('select[name="diseaseCode"]') as HTMLSelectElement).value,
      ).toBe("canine_brucellosis"),
    );
  });
});
