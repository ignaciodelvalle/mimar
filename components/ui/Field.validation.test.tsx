// @vitest-environment jsdom
//
// Localized native validation (QA round 2 2026-07-03 #6): the browser's
// constraint bubble follows the BROWSER language, so es-AR forms surfaced
// "Please fill out this field." — every LN control must localize the bubble
// via setCustomValidity at `invalid` time and clear it on input.

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LnInput, LnSelect, LnTextarea, localizedValidationMessage } from "./Field";

describe("localizedValidationMessage", () => {
  it("maps valueMissing to the es-AR required message", () => {
    const input = document.createElement("input");
    input.required = true;
    expect(input.validity.valueMissing).toBe(true);
    expect(localizedValidationMessage(input)).toBe("Completá este campo.");
  });

  it("maps a too-short value to a minLength message", () => {
    // jsdom only flags tooShort after simulating a dirty user edit — assert
    // the mapping against a minimal stand-in instead.
    const fake = {
      validity: { valueMissing: false, tooShort: true },
      minLength: 5,
    } as unknown as HTMLInputElement;
    expect(localizedValidationMessage(fake)).toBe("Usá al menos 5 caracteres.");
  });
});

describe("LN controls localize the native bubble on invalid", () => {
  it.each([
    ["LnInput", <LnInput key="i" name="f" required />],
    ["LnTextarea", <LnTextarea key="t" name="f" required />],
    [
      "LnSelect",
      <LnSelect key="s" name="f" required>
        <option value="">—</option>
      </LnSelect>,
    ],
  ])("%s sets the es-AR message when the invalid event fires", (_name, element) => {
    const { container } = render(element);
    const control = container.querySelector("input, textarea, select") as HTMLInputElement;
    fireEvent.invalid(control);
    expect(control.validationMessage).toBe("Completá este campo.");
  });

  it("clears the custom message on input so revalidation runs natively", () => {
    const { container } = render(<LnInput name="f" required />);
    const control = container.querySelector("input") as HTMLInputElement;
    fireEvent.invalid(control);
    expect(control.validationMessage).toBe("Completá este campo.");
    fireEvent.input(control, { target: { value: "hola" } });
    expect(control.validationMessage).toBe("");
  });
});
