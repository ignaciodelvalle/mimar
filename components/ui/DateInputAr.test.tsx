// @vitest-environment jsdom
//
// DateInputAr is the browser-independent dd/mm/aaaa date entry that replaced
// native `<input type="date">` on the operator filter surfaces (Safari/Firefox
// showed mm/dd/yyyy and submitted the wrong range). These tests pin the load-
// bearing contract:
//   - the SUBMITTED value is always ISO yyyy-mm-dd on a named hidden input, so
//     the GET filter query is unchanged,
//   - the VISIBLE value is dd/mm/aaaa text we control (never a native date),
//   - an impossible date is CLEARED (hidden ISO empties) with an inline hint,
//   - it is keyboard-operable and label-associable.

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DateInputAr } from "./DateInputAr";

function hidden(container: HTMLElement, name: string): HTMLInputElement {
  return container.querySelector(`input[type="hidden"][name="${name}"]`) as HTMLInputElement;
}

function textbox(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[type="text"]') as HTMLInputElement;
}

describe("DateInputAr", () => {
  it("renders an ISO defaultValue as dd/mm/aaaa but submits the ISO value", () => {
    const { container } = render(<DateInputAr name="from" defaultValue="2026-07-03" />);
    expect(textbox(container).value).toBe("03/07/2026");
    expect(hidden(container, "from").value).toBe("2026-07-03");
  });

  it("renders a blank field for an empty/undefined default", () => {
    const { container } = render(<DateInputAr name="from" defaultValue={null} />);
    expect(textbox(container).value).toBe("");
    expect(hidden(container, "from").value).toBe("");
  });

  it("does NOT render a native date input (the whole point)", () => {
    const { container } = render(<DateInputAr name="from" />);
    expect(container.querySelector('input[type="date"]')).toBeNull();
    // The visible input carries no name — only the hidden ISO field is submitted.
    expect(textbox(container).getAttribute("name")).toBeNull();
  });

  it("keyboard entry of dd/mm/aaaa parses to ISO on blur (03/07 => 3-July)", () => {
    const { container } = render(<DateInputAr name="from" />);
    const input = textbox(container);
    // Simulate typing digits — the mask inserts slashes.
    fireEvent.change(input, { target: { value: "03072026" } });
    expect(input.value).toBe("03/07/2026");
    fireEvent.blur(input);
    expect(input.value).toBe("03/07/2026");
    expect(hidden(container, "from").value).toBe("2026-07-03");
  });

  it("syncs the submitted ISO on CHANGE, before blur (implicit Enter submit)", () => {
    // A GET-form Enter submit does not blur the field first, so the hidden ISO
    // must already be current when the date is complete — else the typed value
    // is silently dropped (the Cursor-review HIGH regression).
    const { container } = render(<DateInputAr name="from" />);
    const input = textbox(container);
    fireEvent.change(input, { target: { value: "15072026" } });
    // No blur fired — the hidden ISO is already the typed date.
    expect(hidden(container, "from").value).toBe("2026-07-15");
  });

  it("re-editing an existing date updates the ISO on change, not a stale value", () => {
    const { container } = render(<DateInputAr name="from" defaultValue="2026-07-01" />);
    const input = textbox(container);
    expect(hidden(container, "from").value).toBe("2026-07-01");
    fireEvent.change(input, { target: { value: "15072026" } });
    expect(hidden(container, "from").value).toBe("2026-07-15");
  });

  it("ignores a calendar-invalid ISO default (tampered URL) — renders blank", () => {
    const { container } = render(<DateInputAr name="from" defaultValue="2026-99-99" />);
    expect(textbox(container).value).toBe("");
    expect(hidden(container, "from").value).toBe("");
  });

  it("clears the submitted ISO and shows an inline hint for an impossible date", () => {
    const { container } = render(<DateInputAr name="from" defaultValue="2026-07-03" />);
    const input = textbox(container);
    fireEvent.change(input, { target: { value: "32/13/2026" } });
    fireEvent.blur(input);
    expect(hidden(container, "from").value).toBe("");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const error = container.querySelector('[role="alert"]') as HTMLElement;
    expect(error).not.toBeNull();
    expect(error.textContent).toBe("Fecha inválida (usá dd/mm/aaaa)");
    expect(input.getAttribute("aria-describedby")).toBe(error.id);
  });

  it("clearing the field empties the submitted ISO without an error", () => {
    const { container } = render(<DateInputAr name="from" defaultValue="2026-07-03" />);
    const input = textbox(container);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(hidden(container, "from").value).toBe("");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });

  it("exposes an accessible name and numeric input mode", () => {
    const { container } = render(<DateInputAr name="from" ariaLabel="Desde" />);
    const input = textbox(container);
    expect(input.getAttribute("aria-label")).toBe("Desde");
    expect(input.getAttribute("inputmode")).toBe("numeric");
    expect(input.getAttribute("placeholder")).toBe("dd/mm/aaaa");
  });

  it("binds an external <label htmlFor> via the id prop", () => {
    const { container } = render(
      <>
        <label htmlFor="audit-from">Desde</label>
        <DateInputAr id="audit-from" name="from" />
      </>,
    );
    expect(textbox(container).id).toBe("audit-from");
  });

  // `required` exists for the drop-in replacement of a native
  // `<input type="date" required>` on a CITIZEN write form (DeathRecordForm's
  // "Fecha" — A3 datetime wave, 2026-08-06). It has to live on the VISIBLE
  // input: a hidden input is barred from constraint validation, so the same
  // attribute on the ISO twin would be silently ignored and an empty submit
  // would reach the server action.
  describe("required", () => {
    it("puts the native constraint on the VISIBLE input, not the hidden ISO one", () => {
      const { container } = render(<DateInputAr name="occurredAt" required />);
      expect(textbox(container).required).toBe(true);
      expect(hidden(container, "occurredAt").required).toBe(false);
    });

    it("is absent by default — the filter surfaces stay optional", () => {
      const { container } = render(<DateInputAr name="from" />);
      expect(textbox(container).required).toBe(false);
    });

    it("localizes the native validation bubble to es-AR", () => {
      const { container } = render(<DateInputAr name="occurredAt" required />);
      const input = textbox(container);
      fireEvent.invalid(input);
      expect(input.validationMessage).toBe("Completá este campo.");
    });

    it("clears the custom message on the next edit so re-validation runs clean", () => {
      const { container } = render(<DateInputAr name="occurredAt" required />);
      const input = textbox(container);
      fireEvent.invalid(input);
      fireEvent.change(input, { target: { value: "03/07/2026" } });
      expect(input.validationMessage).toBe("");
      expect(hidden(container, "occurredAt").value).toBe("2026-07-03");
    });
  });

  // `required` alone CANNOT carry this control: the visible input is a plain
  // TEXT field, so `valueMissing` is satisfied by any non-empty string —
  // "32/13/2026" passes the constraint while the hidden ISO is empty, and the
  // action receives occurredAt="". Native `<input type="date">` got the block
  // from `badInput`; this control has to put it there itself.
  describe("invalid dates BLOCK submission, not just paint an error", () => {
    it("marks the input constraint-invalid once an impossible date is left in it", () => {
      const { container } = render(<DateInputAr name="occurredAt" required />);
      const input = textbox(container);

      fireEvent.change(input, { target: { value: "32132026" } });
      fireEvent.blur(input);

      expect(input.checkValidity()).toBe(false);
      expect(input.validity.customError).toBe(true);
      expect(input.validationMessage).toBe("Fecha inválida (usá dd/mm/aaaa)");
      // The garbage never reaches the wire — the submitted field is empty.
      expect(hidden(container, "occurredAt").value).toBe("");
    });

    it("blocks a real form submit while the date is unparseable, and allows it once fixed", () => {
      const { container } = render(
        <form>
          <DateInputAr name="occurredAt" required />
        </form>,
      );
      const form = container.querySelector("form") as HTMLFormElement;
      const input = textbox(container);

      fireEvent.change(input, { target: { value: "32132026" } });
      fireEvent.blur(input);
      expect(form.checkValidity()).toBe(false);

      fireEvent.change(input, { target: { value: "03072026" } });
      fireEvent.blur(input);
      expect(form.checkValidity()).toBe(true);
      expect(hidden(container, "occurredAt").value).toBe("2026-07-03");
    });

    it("blocks on an OPTIONAL field too — a wrong range is wrong with or without required", () => {
      const { container } = render(<DateInputAr name="from" />);
      const input = textbox(container);

      fireEvent.change(input, { target: { value: "32132026" } });
      fireEvent.blur(input);
      expect(input.checkValidity()).toBe(false);

      // Clearing the field is a legitimate way out of the error, not a trap.
      fireEvent.change(input, { target: { value: "" } });
      fireEvent.blur(input);
      expect(input.checkValidity()).toBe(true);
    });

    it("keeps the es-AR REQUIRED message for the genuinely empty case", () => {
      const { container } = render(<DateInputAr name="occurredAt" required />);
      const input = textbox(container);

      // An invalid event on an EMPTY required field must not inherit the
      // date-format wording, and vice versa.
      fireEvent.invalid(input);
      expect(input.validationMessage).toBe("Completá este campo.");
    });

    it("does NOT overwrite the format message with the required one", () => {
      const { container } = render(<DateInputAr name="occurredAt" required />);
      const input = textbox(container);

      fireEvent.change(input, { target: { value: "32132026" } });
      fireEvent.blur(input);
      // A submit attempt fires `invalid`; the handler must leave the specific
      // message alone rather than telling the user to fill a filled field.
      fireEvent.invalid(input);
      expect(input.validationMessage).toBe("Fecha inválida (usá dd/mm/aaaa)");
    });
  });

  describe("onValueChange (commit-worthy signal)", () => {
    it("fires with the ISO value once a date becomes complete and valid", () => {
      const onValueChange = vi.fn();
      const { container } = render(<DateInputAr name="from" onValueChange={onValueChange} />);
      const input = textbox(container);
      fireEvent.change(input, { target: { value: "1" } });
      fireEvent.change(input, { target: { value: "15" } });
      fireEvent.change(input, { target: { value: "1507" } });
      expect(onValueChange).not.toHaveBeenCalled();
      fireEvent.change(input, { target: { value: "15072026" } });
      expect(onValueChange).toHaveBeenCalledTimes(1);
      expect(onValueChange).toHaveBeenLastCalledWith("2026-07-15");
    });

    it("fires with an empty string once the field is fully cleared", () => {
      const onValueChange = vi.fn();
      const { container } = render(
        <DateInputAr name="from" defaultValue="2026-07-03" onValueChange={onValueChange} />,
      );
      fireEvent.change(textbox(container), { target: { value: "" } });
      expect(onValueChange).toHaveBeenCalledTimes(1);
      expect(onValueChange).toHaveBeenLastCalledWith("");
    });

    it("does NOT fire while a complete-but-impossible date is mid-typed", () => {
      const onValueChange = vi.fn();
      const { container } = render(<DateInputAr name="from" onValueChange={onValueChange} />);
      fireEvent.change(textbox(container), { target: { value: "32132026" } });
      expect(onValueChange).not.toHaveBeenCalled();
    });

    it("does NOT fire again on blur (blur has no separate commit signal)", () => {
      const onValueChange = vi.fn();
      const { container } = render(<DateInputAr name="from" onValueChange={onValueChange} />);
      const input = textbox(container);
      fireEvent.change(input, { target: { value: "15072026" } });
      onValueChange.mockClear();
      fireEvent.blur(input);
      expect(onValueChange).not.toHaveBeenCalled();
    });
  });

  // The composing consumer's contract (PetSightingForm pairs this with a
  // TimeInputAr): this callback tracks the hidden ISO exactly — including the
  // empties `onValueChange` deliberately withholds — so a half-typed date can
  // never leave the composed datetime holding a stale valid one.
  describe("onHiddenValueChange (mirror of the submitted ISO)", () => {
    it("fires with the empty string while a date is incomplete, then with the ISO", () => {
      const onHiddenValueChange = vi.fn();
      const { container } = render(
        <DateInputAr name="from" onHiddenValueChange={onHiddenValueChange} />,
      );
      const input = textbox(container);
      fireEvent.change(input, { target: { value: "1507" } });
      expect(onHiddenValueChange).toHaveBeenLastCalledWith("");
      fireEvent.change(input, { target: { value: "15072026" } });
      expect(onHiddenValueChange).toHaveBeenLastCalledWith("2026-07-15");
    });

    it("empties when a previously valid date is edited down to a partial one", () => {
      const onHiddenValueChange = vi.fn();
      const { container } = render(
        <DateInputAr
          name="from"
          defaultValue="2026-07-03"
          onHiddenValueChange={onHiddenValueChange}
        />,
      );
      fireEvent.change(textbox(container), { target: { value: "0307202" } });
      expect(onHiddenValueChange).toHaveBeenLastCalledWith("");
    });

    it("empties on blur for an impossible date", () => {
      const onHiddenValueChange = vi.fn();
      const { container } = render(
        <DateInputAr
          name="from"
          defaultValue="2026-07-03"
          onHiddenValueChange={onHiddenValueChange}
        />,
      );
      const input = textbox(container);
      fireEvent.change(input, { target: { value: "32132026" } });
      fireEvent.blur(input);
      expect(onHiddenValueChange).toHaveBeenLastCalledWith("");
    });
  });

  describe("aria-invalid forwarding (LnField clone compatibility)", () => {
    it("merges an external aria-invalid onto the visible input", () => {
      const { container } = render(<DateInputAr name="d" aria-invalid />);
      expect(textbox(container).getAttribute("aria-invalid")).toBe("true");
    });

    it("without the external flag, aria-invalid still follows internal state only", () => {
      const { container } = render(<DateInputAr name="d" />);
      expect(textbox(container).getAttribute("aria-invalid")).toBeNull();
    });
  });
});
