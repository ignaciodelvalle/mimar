// @vitest-environment jsdom
//
// TimeInputAr is the browser-independent HH:mm entry that replaced native
// `<input type="time">` on the citizen crisis forms (an en-US browser rendered
// a 12-hour AM/PM widget inside 24-hour es-AR copy, on the field that says WHEN
// a lost pet was seen). These tests pin the load-bearing contract, mirroring
// DateInputAr.test.tsx:
//   - the SUBMITTED value is always "HH:mm" on a named hidden input,
//   - the VISIBLE value is HH:mm text we control (never a native time widget),
//   - an out-of-range time is CLEARED (hidden value empties) with an inline hint,
//   - it is keyboard-operable and label-associable.

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TimeInputAr } from "./TimeInputAr";

function hidden(container: HTMLElement, name: string): HTMLInputElement {
  return container.querySelector(`input[type="hidden"][name="${name}"]`) as HTMLInputElement;
}

function textbox(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[type="text"]') as HTMLInputElement;
}

describe("TimeInputAr", () => {
  it("renders an HH:mm defaultValue and submits it unchanged", () => {
    const { container } = render(<TimeInputAr name="sightedAtTime" defaultValue="19:30" />);
    expect(textbox(container).value).toBe("19:30");
    expect(hidden(container, "sightedAtTime").value).toBe("19:30");
  });

  it("renders a blank field for an empty/undefined default", () => {
    const { container } = render(<TimeInputAr name="sightedAtTime" defaultValue={null} />);
    expect(textbox(container).value).toBe("");
    expect(hidden(container, "sightedAtTime").value).toBe("");
  });

  it("does NOT render a native time input (the whole point)", () => {
    const { container } = render(<TimeInputAr name="sightedAtTime" />);
    expect(container.querySelector('input[type="time"]')).toBeNull();
    // The visible input carries no name — only the hidden field is submitted.
    expect(textbox(container).getAttribute("name")).toBeNull();
  });

  it("keyboard entry of digits masks to HH:mm and submits it", () => {
    const { container } = render(<TimeInputAr name="sightedAtTime" />);
    const input = textbox(container);
    fireEvent.change(input, { target: { value: "1930" } });
    expect(input.value).toBe("19:30");
    fireEvent.blur(input);
    expect(input.value).toBe("19:30");
    expect(hidden(container, "sightedAtTime").value).toBe("19:30");
  });

  it("syncs the submitted value on CHANGE, before blur (implicit Enter submit)", () => {
    const { container } = render(<TimeInputAr name="sightedAtTime" />);
    fireEvent.change(textbox(container), { target: { value: "0705" } });
    // No blur fired — the hidden value is already the typed time.
    expect(hidden(container, "sightedAtTime").value).toBe("07:05");
  });

  it("ignores an out-of-range default (tampered value) — renders blank", () => {
    const { container } = render(<TimeInputAr name="sightedAtTime" defaultValue="99:99" />);
    expect(textbox(container).value).toBe("");
    expect(hidden(container, "sightedAtTime").value).toBe("");
  });

  it("clears the submitted value and shows an inline hint for an impossible time", () => {
    const { container } = render(<TimeInputAr name="sightedAtTime" defaultValue="19:30" />);
    const input = textbox(container);
    fireEvent.change(input, { target: { value: "25:00" } });
    fireEvent.blur(input);
    expect(hidden(container, "sightedAtTime").value).toBe("");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const error = container.querySelector('[role="alert"]') as HTMLElement;
    expect(error).not.toBeNull();
    expect(error.textContent).toBe("Hora inválida (usá hh:mm, 24 h)");
    expect(input.getAttribute("aria-describedby")).toBe(error.id);
  });

  it("clearing the field empties the submitted value without an error", () => {
    const { container } = render(<TimeInputAr name="sightedAtTime" defaultValue="19:30" />);
    const input = textbox(container);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(hidden(container, "sightedAtTime").value).toBe("");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });

  it("exposes an accessible name, numeric input mode and an hh:mm placeholder", () => {
    const { container } = render(<TimeInputAr name="sightedAtTime" ariaLabel="Hora" />);
    const input = textbox(container);
    expect(input.getAttribute("aria-label")).toBe("Hora");
    expect(input.getAttribute("inputmode")).toBe("numeric");
    expect(input.getAttribute("placeholder")).toBe("hh:mm");
  });

  it("binds an external <label htmlFor> via the id prop", () => {
    const { container } = render(
      <>
        <label htmlFor="sighted-time">Hora</label>
        <TimeInputAr id="sighted-time" name="sightedAtTime" />
      </>,
    );
    expect(textbox(container).id).toBe("sighted-time");
  });

  it("merges an external ariaDescribedBy with its own invalid hint", () => {
    const { container } = render(<TimeInputAr name="sightedAtTime" ariaDescribedBy="form-error" />);
    const input = textbox(container);
    expect(input.getAttribute("aria-describedby")).toBe("form-error");
    fireEvent.change(input, { target: { value: "2500" } });
    fireEvent.blur(input);
    const error = container.querySelector('[role="alert"]') as HTMLElement;
    expect(input.getAttribute("aria-describedby")).toBe(`form-error ${error.id}`);
  });

  describe("onValueChange (commit-worthy signal)", () => {
    it("fires with the HH:mm value once a time becomes complete and valid", () => {
      const onValueChange = vi.fn();
      const { container } = render(
        <TimeInputAr name="sightedAtTime" onValueChange={onValueChange} />,
      );
      const input = textbox(container);
      fireEvent.change(input, { target: { value: "1" } });
      fireEvent.change(input, { target: { value: "19" } });
      fireEvent.change(input, { target: { value: "193" } });
      expect(onValueChange).not.toHaveBeenCalled();
      fireEvent.change(input, { target: { value: "1930" } });
      expect(onValueChange).toHaveBeenCalledTimes(1);
      expect(onValueChange).toHaveBeenLastCalledWith("19:30");
    });

    it("fires with an empty string once the field is fully cleared", () => {
      const onValueChange = vi.fn();
      const { container } = render(
        <TimeInputAr name="sightedAtTime" defaultValue="19:30" onValueChange={onValueChange} />,
      );
      fireEvent.change(textbox(container), { target: { value: "" } });
      expect(onValueChange).toHaveBeenCalledTimes(1);
      expect(onValueChange).toHaveBeenLastCalledWith("");
    });

    it("does NOT fire while a complete-but-impossible time is mid-typed", () => {
      const onValueChange = vi.fn();
      const { container } = render(
        <TimeInputAr name="sightedAtTime" onValueChange={onValueChange} />,
      );
      fireEvent.change(textbox(container), { target: { value: "2560" } });
      expect(onValueChange).not.toHaveBeenCalled();
    });
  });

  // The composing consumer's contract (PetSightingForm): this callback tracks
  // the hidden input exactly, so a half-typed or impossible time can never leave
  // the composed "YYYY-MM-DDTHH:mm" holding a stale valid one.
  describe("onHiddenValueChange (mirror of the submitted value)", () => {
    it("fires with the empty string while a time is incomplete, then with the value", () => {
      const onHiddenValueChange = vi.fn();
      const { container } = render(
        <TimeInputAr name="sightedAtTime" onHiddenValueChange={onHiddenValueChange} />,
      );
      const input = textbox(container);
      fireEvent.change(input, { target: { value: "19" } });
      expect(onHiddenValueChange).toHaveBeenLastCalledWith("");
      fireEvent.change(input, { target: { value: "1930" } });
      expect(onHiddenValueChange).toHaveBeenLastCalledWith("19:30");
    });

    it("empties when a previously valid time is edited down to a partial one", () => {
      const onHiddenValueChange = vi.fn();
      const { container } = render(
        <TimeInputAr
          name="sightedAtTime"
          defaultValue="19:30"
          onHiddenValueChange={onHiddenValueChange}
        />,
      );
      fireEvent.change(textbox(container), { target: { value: "193" } });
      expect(onHiddenValueChange).toHaveBeenLastCalledWith("");
    });

    it("empties on blur for an out-of-range time", () => {
      const onHiddenValueChange = vi.fn();
      const { container } = render(
        <TimeInputAr
          name="sightedAtTime"
          defaultValue="19:30"
          onHiddenValueChange={onHiddenValueChange}
        />,
      );
      const input = textbox(container);
      fireEvent.change(input, { target: { value: "2500" } });
      fireEvent.blur(input);
      expect(onHiddenValueChange).toHaveBeenLastCalledWith("");
    });
  });

  // Same reasoning as DateInputAr's twin block: the visible input is a plain
  // TEXT field, so every native constraint a text field has is satisfied by
  // "25:00" while the hidden value is empty. The inline hint has to be backed
  // by setCustomValidity or the form submits an emptied hour anyway.
  describe("out-of-range times BLOCK submission, not just paint an error", () => {
    it("marks the input constraint-invalid once an impossible time is left in it", () => {
      const { container } = render(<TimeInputAr name="sightedAtTime" />);
      const input = textbox(container);

      fireEvent.change(input, { target: { value: "2500" } });
      fireEvent.blur(input);

      expect(input.checkValidity()).toBe(false);
      expect(input.validity.customError).toBe(true);
      expect(input.validationMessage).toBe("Hora inválida (usá hh:mm, 24 h)");
      expect(hidden(container, "sightedAtTime").value).toBe("");
    });

    it("blocks a real form submit while the time is unparseable, and allows it once fixed", () => {
      const { container } = render(
        <form>
          <TimeInputAr name="sightedAtTime" />
        </form>,
      );
      const form = container.querySelector("form") as HTMLFormElement;
      const input = textbox(container);

      fireEvent.change(input, { target: { value: "2500" } });
      fireEvent.blur(input);
      expect(form.checkValidity()).toBe(false);

      fireEvent.change(input, { target: { value: "1930" } });
      fireEvent.blur(input);
      expect(form.checkValidity()).toBe(true);
      expect(hidden(container, "sightedAtTime").value).toBe("19:30");
    });

    it("lets a cleared field out of the error state", () => {
      const { container } = render(<TimeInputAr name="sightedAtTime" />);
      const input = textbox(container);

      fireEvent.change(input, { target: { value: "1275" } });
      fireEvent.blur(input);
      expect(input.checkValidity()).toBe(false);

      fireEvent.change(input, { target: { value: "" } });
      fireEvent.blur(input);
      expect(input.checkValidity()).toBe(true);
    });
  });

  describe("aria-invalid forwarding (LnField clone compatibility)", () => {
    it("merges an external aria-invalid onto the visible input", () => {
      const { container } = render(<TimeInputAr name="t" aria-invalid />);
      expect(textbox(container).getAttribute("aria-invalid")).toBe("true");
    });

    it("without the external flag, aria-invalid still follows internal state only", () => {
      const { container } = render(<TimeInputAr name="t" />);
      expect(textbox(container).getAttribute("aria-invalid")).toBeNull();
    });
  });
});
